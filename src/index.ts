/**
 * Fleet Vector API — Semantic crate search with Workers AI + Vectorize
 *
 * Production pipeline:
 *   Crate README → Workers AI (bge-small-en-v1.5) → 384-dim → Vectorize index
 *   Search query → Workers AI embedding → Vectorize cosine query
 */

interface Env {
  AI: any;
  CRATE_INDEX: VectorizeIndex;
  META_KV: KVNamespace;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMS: string;
  BATCH_SIZE: string;
  INGEST_SECRET: string;
}

interface CrateInput {
  name: string;
  description: string;
  readme: string;
  version?: string;
  domain?: string;
  wave?: number;
  tests?: number;
  loc?: number;
  github_url?: string;
  keywords?: string[];
}

interface CrateMetadata {
  name: string;
  description: string;
  version: string;
  domain: string;
  wave: number;
  tests: number;
  loc: number;
  github_url: string;
  keywords: string[];
  embedded_at: number;
  model: string;
  dims: number;
}

// ─── Embedding ─────────────────────────────────────────────────────────────

async function embedText(text: string, ai: any, model: string): Promise<number[]> {
  const response = await ai.run(model, { text: [text.slice(0, 2000)], pooling: 'cls' });
  const data: number[] = response.data[0];
  const mag = Math.sqrt(data.reduce((s: number, v: number) => s + v * v, 0)) || 1;
  return data.map((v: number) => v / mag);
}

async function embedBatch(texts: string[], ai: any, model: string): Promise<number[][]> {
  const response = await ai.run(model, {
    text: texts.map(t => t.slice(0, 2000)),
    pooling: 'cls',
  });
  const results: number[][] = [];
  for (const vec of response.data) {
    const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
    results.push(vec.map((v: number) => v / mag));
  }
  return results;
}

function buildEmbeddingText(crate: CrateInput): string {
  return [
    `${crate.name}: ${crate.description}`,
    crate.keywords?.length ? `Keywords: ${crate.keywords.join(', ')}` : '',
    crate.readme?.slice(0, 1500) || '',
  ].filter(Boolean).join('\n\n');
}

// ─── Handlers ──────────────────────────────────────────────────────────────

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── Auth ─────────────────────────────────────────────────────────────────

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  return token === env.INGEST_SECRET;
}

function apiError(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      ...corsHeaders,
    },
  });
}

/** POST /ingest — Embed crates and insert into Vectorize */
async function handleIngest(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { crates?: CrateInput[] } | CrateInput;
  const crates = Array.isArray(body) ? body : ('crates' in body ? body.crates! : [body]);
  if (!crates.length) return apiError('BAD_REQUEST', 'No crates provided', 400);
  if (crates.length > 50) return apiError('BAD_REQUEST', 'Max 50 crates per request', 400);

  const texts = crates.map(c => buildEmbeddingText(c));
  const vectors = await embedBatch(texts, env.AI, env.EMBEDDING_MODEL);

  // Build Vectorize vectors
  const vecs = crates.map((c, i) => ({
    id: c.name,
    values: vectors[i],
    metadata: {
      name: c.name,
      desc: c.description?.slice(0, 200) || '',
      domain: c.domain || 'unknown',
      tests: String(c.tests || 0),
      ver: c.version || '0.1.0',
    },
  }));

  // Upsert into Vectorize
  const upsertResult = await env.CRATE_INDEX.upsert(vecs);

  // Store full metadata in KV
  let indexRaw = await env.META_KV.get('_crate_index');
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

  for (const [i, crate] of crates.entries()) {
    const meta: CrateMetadata = {
      name: crate.name,
      description: crate.description || '',
      version: crate.version || '0.1.0',
      domain: crate.domain || 'unknown',
      wave: crate.wave || 0,
      tests: crate.tests || 0,
      loc: crate.loc || 0,
      github_url: crate.github_url || '',
      keywords: crate.keywords || [],
      embedded_at: Date.now(),
      model: env.EMBEDDING_MODEL,
      dims: parseInt(env.EMBEDDING_DIMS || '384'),
    };
    await env.META_KV.put(`crate:${crate.name}`, JSON.stringify(meta));
    if (!index.includes(crate.name)) index.push(crate.name);
  }

  await env.META_KV.put('_crate_index', JSON.stringify(index));
  await env.META_KV.put('_stats:count', String(index.length));
  await env.META_KV.put('_stats:last_ingest', new Date().toISOString());

  return json({ ok: true, inserted: crates.length, vectorize_upsert: upsertResult });
}

/** POST /search — Semantic search via Vectorize */
async function handleSearch(request: Request, env: Env): Promise<Response> {
  const { query, topK = 10 } = await request.json() as { query: string; topK?: number };
  if (!query) return apiError('BAD_REQUEST', 'Query parameter is required', 400);

  const queryVector = await embedText(query, env.AI, env.EMBEDDING_MODEL);
  const results = await env.CRATE_INDEX.query(queryVector, {
    topK: Math.min(topK, 50),
    returnMetadata: 'all',
  });

  // Enrich with KV metadata
  const enriched = await Promise.all(
    (results.matches || []).map(async (m: any) => {
      const metaRaw = await env.META_KV.get(`crate:${m.id}`);
      return { id: m.id, score: m.score, ...(metaRaw ? JSON.parse(metaRaw) : m.metadata) };
    }),
  );

  return json({ query, model: env.EMBEDDING_MODEL, results: enriched, count: enriched.length });
}

/** POST /similar — Find similar crates via Vectorize */
async function handleSimilar(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as Record<string, any>;
  const crate_name = body.crate_name || body.name || body.id || '';
  if (!crate_name) return apiError('BAD_REQUEST', 'crate_name, name, or id is required', 400);
  const topK = body.topK || 10;
  const metaRaw = await env.META_KV.get(`crate:${crate_name}`);
  if (!metaRaw) return apiError('NOT_FOUND', `Crate not found: ${crate_name}. Try /search to find crates by topic.`, 404);

  const meta: CrateMetadata = JSON.parse(metaRaw);
  const queryVector = await embedText(
    `${meta.name}: ${meta.description} ${(meta.keywords || []).join(' ')}`,
    env.AI, env.EMBEDDING_MODEL,
  );

  const results = await env.CRATE_INDEX.query(queryVector, {
    topK: topK + 1,
    returnMetadata: 'all',
  });

  const filtered = (results.matches || [])
    .filter((m: any) => m.id !== crate_name)
    .slice(0, topK);

  return json({ crate: crate_name, similar: filtered, count: filtered.length });
}

/** GET /crates/:name */
async function handleGetCrate(name: string, env: Env): Promise<Response> {
  const raw = await env.META_KV.get(`crate:${name}`);
  if (!raw) return apiError('NOT_FOUND', `Crate not found: ${name}`, 404);
  return json(JSON.parse(raw));
}

/** GET /stats */
async function handleStats(env: Env): Promise<Response> {
  const count = await env.META_KV.get('_stats:count');
  const lastIngest = await env.META_KV.get('_stats:last_ingest');
  return json({
    service: 'fleet-vector-api',
    model: env.EMBEDDING_MODEL,
    dimensions: parseInt(env.EMBEDDING_DIMS || '384'),
    crate_count: count ? parseInt(count) : 0,
    last_ingest: lastIngest || 'never',
    backend: 'cloudflare-vectorize',
    index: 'fleet-crates',
  });
}

// ─── Helper: Load all crate metadata ────────────────────────────────────

async function loadAllCrates(env: Env): Promise<CrateMetadata[]> {
  const indexRaw = await env.META_KV.get('_crate_index');
  if (!indexRaw) return [];
  const names: string[] = JSON.parse(indexRaw);
  const crates: CrateMetadata[] = [];
  // Load in batches of 50
  for (let i = 0; i < names.length; i += 50) {
    const batch = names.slice(i, i + 50);
    const results = await Promise.all(batch.map(n => env.META_KV.get(`crate:${n}`)));
    for (const raw of results) {
      if (raw) crates.push(JSON.parse(raw));
    }
  }
  return crates;
}

/** POST /recommend — Context-aware crate recommendations with reasoning */
async function handleRecommend(request: Request, env: Env): Promise<Response> {
  const { context, topK = 5 } = await request.json() as { context: string; topK?: number };
  if (!context) return apiError('BAD_REQUEST', 'context parameter is required', 400);

  const queryVector = await embedText(context, env.AI, env.EMBEDDING_MODEL);
  const results = await env.CRATE_INDEX.query(queryVector, {
    topK: Math.min(topK * 3, 50), // over-fetch to allow quality filtering
    returnMetadata: 'all',
  });

  // Enrich with full metadata
  const candidates = await Promise.all(
    (results.matches || []).map(async (m: any) => {
      const metaRaw = await env.META_KV.get(`crate:${m.id}`);
      const meta: CrateMetadata | null = metaRaw ? JSON.parse(metaRaw) : null;
      return { id: m.id, score: m.score, ...meta };
    }),
  );

  // Score with quality signals
  const scored = candidates.map(c => {
    const semanticScore = c.score || 0;
    const testBonus = Math.min((c.tests || 0) / 20, 1) * 0.1; // up to 0.1
    const locBonus = Math.min((c.loc || 0) / 5000, 1) * 0.05; // up to 0.05
    const descBonus = (c.description && c.description.length > 20) ? 0.03 : 0;
    const compositeScore = semanticScore + testBonus + locBonus + descBonus;

    const reasons: string[] = [`Semantic relevance: ${(semanticScore * 100).toFixed(1)}%`];
    if (c.tests > 0) reasons.push(`${c.tests} tests`);
    if (c.loc > 0) reasons.push(`${c.loc} LOC`);
    if (c.domain && c.domain !== 'unknown') reasons.push(`Domain: ${c.domain}`);

    return { ...c, compositeScore, reasons };
  });

  // Sort by composite, take topK
  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  const recommendations = scored.slice(0, topK).map(({ score, compositeScore, reasons, ...rest }) => ({
    name: rest.name || rest.id,
    description: rest.description || '',
    domain: rest.domain || 'unknown',
    version: rest.version || '0.1.0',
    semantic_score: score,
    composite_score: Math.round(compositeScore * 1000) / 1000,
    quality_signals: {
      tests: rest.tests || 0,
      loc: rest.loc || 0,
      has_description: !!(rest.description && rest.description.length > 20),
    },
    reasoning: reasons,
  }));

  return json({ context, recommendations, count: recommendations.length });
}

/** GET /clusters — Domain clusters with inter-cluster similarity */
async function handleClusters(env: Env): Promise<Response> {
  const crates = await loadAllCrates(env);
  if (!crates.length) return json({ clusters: [], count: 0 });

  // Group by domain
  const domainMap = new Map<string, CrateMetadata[]>();
  for (const c of crates) {
    const domain = c.domain || 'unknown';
    if (!domainMap.has(domain)) domainMap.set(domain, []);
    domainMap.get(domain)!.push(c);
  }

  // Build cluster summaries
  const clusters = Array.from(domainMap.entries()).map(([domain, members]) => {
    const totalTests = members.reduce((s, c) => s + (c.tests || 0), 0);
    const totalLoc = members.reduce((s, c) => s + (c.loc || 0), 0);
    const avgTests = members.length ? Math.round(totalTests / members.length) : 0;
    const keywords = new Map<string, number>();
    for (const m of members) {
      for (const kw of (m.keywords || [])) {
        keywords.set(kw, (keywords.get(kw) || 0) + 1);
      }
    }
    const topKeywords = [...keywords.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([kw]) => kw);

    return {
      domain,
      crate_count: members.length,
      crates: members.map(m => m.name).sort(),
      total_tests: totalTests,
      total_loc: totalLoc,
      avg_tests_per_crate: avgTests,
      top_keywords: topKeywords,
    };
  });

  // Compute inter-cluster similarity via shared keywords
  const domainNames = clusters.map(c => c.domain);
  const crossRefs: Array<{ domains: [string, string]; shared_keywords: string[]; similarity: number }> = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const shared = clusters[i].top_keywords.filter(k => clusters[j].top_keywords.includes(k));
      if (shared.length > 0) {
        const maxKw = Math.max(clusters[i].top_keywords.length, clusters[j].top_keywords.length, 1);
        crossRefs.push({
          domains: [clusters[i].domain, clusters[j].domain],
          shared_keywords: shared,
          similarity: Math.round((shared.length / maxKw) * 100) / 100,
        });
      }
    }
  }
  crossRefs.sort((a, b) => b.similarity - a.similarity);

  return json({ clusters, inter_cluster: crossRefs, total_domains: clusters.length, total_crates: crates.length });
}

/** POST /gap-analysis — Find underdeveloped crates in a domain */
async function handleGapAnalysis(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { domain?: string };
  const domain = body.domain;
  const crates = await loadAllCrates(env);
  if (!crates.length) return apiError('NOT_FOUND', 'No crates found in the index', 404);

  // Filter to domain if specified
  const targetCrates = domain
    ? crates.filter(c => (c.domain || 'unknown') === domain)
    : crates;

  if (domain && !targetCrates.length) return apiError('NOT_FOUND', `No crates found in domain: ${domain}`, 404);

  // Identify gaps
  const gaps = targetCrates
    .map(c => {
      const issues: string[] = [];
      if (!c.description || c.description.length < 10) issues.push('missing_description');
      if ((c.tests || 0) === 0) issues.push('no_tests');
      if ((c.tests || 0) > 0 && (c.tests || 0) < 5) issues.push('low_test_count');
      if ((c.loc || 0) === 0) issues.push('zero_loc');
      if ((c.loc || 0) > 0 && (c.loc || 0) < 100) issues.push('low_loc');
      const severity = issues.length;
      return { name: c.name, domain: c.domain, issues, severity, tests: c.tests || 0, loc: c.loc || 0, description: c.description || '' };
    })
    .filter(c => c.issues.length > 0)
    .sort((a, b) => b.severity - a.severity);

  // Find high-quality reference crates from other domains
  const allCratesSorted = [...crates].sort((a, b) => {
    const scoreA = (a.tests || 0) * 2 + (a.loc || 0) / 100 + (a.description?.length || 0) / 50;
    const scoreB = (b.tests || 0) * 2 + (b.loc || 0) / 100 + (b.description?.length || 0) / 50;
    return scoreB - scoreA;
  });
  const references = allCratesSorted
    .filter(c => domain ? (c.domain || 'unknown') !== domain : true)
    .slice(0, 5)
    .map(c => ({ name: c.name, domain: c.domain, tests: c.tests || 0, loc: c.loc || 0, reason: 'high_quality_reference' }));

  // Priority suggestions
  const suggestions = gaps.slice(0, 10).map(g => {
    const priority = g.severity >= 3 ? 'critical' : g.severity >= 2 ? 'high' : 'medium';
    const suggestion = [];
    if (g.issues.includes('no_tests') || g.issues.includes('low_test_count')) {
      suggestion.push('Add comprehensive test suite');
    }
    if (g.issues.includes('missing_description')) {
      suggestion.push('Write a descriptive README and description');
    }
    if (g.issues.includes('zero_loc') || g.issues.includes('low_loc')) {
      suggestion.push('Implement core functionality (currently appears to be a stub)');
    }
    return { ...g, priority, suggestion };
  });

  const qualityCrates = targetCrates.length - gaps.length;
  return json({
    domain: domain || 'all',
    total_crates: targetCrates.length,
    quality_crates: qualityCrates,
    gap_crates: gaps.length,
    gap_percentage: targetCrates.length ? Math.round((gaps.length / targetCrates.length) * 100) : 0,
    suggestions,
    references,
  });
}

/** GET /dashboard — JSON summary for website dashboard */
async function handleDashboard(env: Env): Promise<Response> {
  const crates = await loadAllCrates(env);
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  // Total & quality breakdown
  let high = 0, medium = 0, low = 0, stub = 0;
  for (const c of crates) {
    const qScore = (c.tests || 0) * 2 + (c.loc || 0) / 100;
    if (qScore >= 20) high++;
    else if (qScore >= 5) medium++;
    else if (qScore > 0) low++;
    else stub++;
  }

  // Domain distribution
  const domainDist: Record<string, number> = {};
  for (const c of crates) {
    const d = c.domain || 'unknown';
    domainDist[d] = (domainDist[d] || 0) + 1;
  }

  // Recently published (embedded in last week)
  const recent = crates
    .filter(c => (c.embedded_at || 0) > now - oneWeekMs)
    .sort((a, b) => (b.embedded_at || 0) - (a.embedded_at || 0))
    .slice(0, 10)
    .map(c => ({ name: c.name, domain: c.domain, version: c.version }));

  // Most similar pairs (sample via vectorize)
  let similarPairs: Array<{ crate_a: string; crate_b: string; score: number }> = [];
  try {
    // Sample a few crates and find their nearest neighbors
    const sampleCrates = crates.slice(0, 5);
    for (const sc of sampleCrates) {
      const queryText = `${sc.name}: ${sc.description} ${(sc.keywords || []).join(' ')}`;
      const vec = await embedText(queryText, env.AI, env.EMBEDDING_MODEL);
      const res = await env.CRATE_INDEX.query(vec, { topK: 2, returnMetadata: 'all' });
      for (const m of (res.matches || []).filter((m: any) => m.id !== sc.name)) {
        similarPairs.push({ crate_a: sc.name, crate_b: m.id, score: m.score });
      }
    }
    similarPairs.sort((a, b) => b.score - a.score);
    similarPairs = similarPairs.slice(0, 10);
  } catch {
    // Non-critical, skip if fails
  }

  // Quick gap analysis summary
  const gapSummary: Record<string, { total: number; gaps: number }> = {};
  for (const [domain, _] of Object.entries(domainDist)) {
    const domainCrates = crates.filter(c => (c.domain || 'unknown') === domain);
    const gaps = domainCrates.filter(c => {
      return (!c.description || c.description.length < 10) || (c.tests || 0) < 5 || (c.loc || 0) < 100;
    }).length;
    gapSummary[domain] = { total: domainCrates.length, gaps };
  }

  return json({
    total_crates: crates.length,
    quality_breakdown: { high, medium, low, stub },
    domain_distribution: domainDist,
    recently_published: recent,
    most_similar_pairs: similarPairs,
    gap_analysis: gapSummary,
    generated_at: new Date().toISOString(),
  });
}

/** POST /embed — Debug */
async function handleEmbed(request: Request, env: Env): Promise<Response> {
  const { text } = await request.json() as { text: string };
  if (!text) return apiError('BAD_REQUEST', 'Text parameter is required', 400);
  const vector = await embedText(text, env.AI, env.EMBEDDING_MODEL);
  return json({
    text: text.slice(0, 200), model: env.EMBEDDING_MODEL,
    dimensions: vector.length,
    vector_preview: vector.slice(0, 10),
    magnitude: Math.sqrt(vector.reduce((s, v) => s + v * v, 0)),
  });
}

// ─── OpenAPI Spec ─────────────────────────────────────────────────────────

const OPENAPI_YAML = `openapi: 3.1.0
info:
  title: Fleet Vector API
  description: >
    Semantic crate intelligence powered by Cloudflare Workers AI and Vectorize.
    Provides vector-based search, similarity, recommendations, gap analysis,
    and dashboard aggregation for the Fleet crate registry.
  version: 1.0.0
  contact:
    name: Casey DiGennaro
    email: casey.digennaro@gmail.com

servers:
  - url: https://fleet-vector-api.casey-digennaro.workers.dev
    description: Production

security: []

paths:
  /search:
    post:
      operationId: search
      summary: Semantic crate search
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [query]
              properties:
                query:
                  type: string
                topK:
                  type: integer
                  default: 10
      responses:
        "200":
          description: Search results
        "400":
          description: Missing or invalid query

  /similar:
    post:
      operationId: similar
      summary: Find similar crates
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                crate_name:
                  type: string
                name:
                  type: string
                id:
                  type: string
                topK:
                  type: integer
                  default: 10
      responses:
        "200":
          description: Similar crates found
        "404":
          description: Crate not found

  /recommend:
    post:
      operationId: recommend
      summary: Context-aware crate recommendations
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [context]
              properties:
                context:
                  type: string
                topK:
                  type: integer
                  default: 5
      responses:
        "200":
          description: Recommendations with reasoning

  /gap-analysis:
    post:
      operationId: gapAnalysis
      summary: Identify underdeveloped crates
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                domain:
                  type: string
      responses:
        "200":
          description: Gap analysis results

  /ingest:
    post:
      operationId: ingest
      summary: Ingest crates into the vector index
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - \$ref: "#/components/schemas/CrateInput"
                - type: object
                  properties:
                    crates:
                      type: array
                      items:
                        \$ref: "#/components/schemas/CrateInput"
                - type: array
                  items:
                    \$ref: "#/components/schemas/CrateInput"
      responses:
        "200":
          description: Crates ingested successfully
        "401":
          description: Missing or invalid Bearer token

  /stats:
    get:
      operationId: getStats
      summary: Index statistics
      responses:
        "200":
          description: Index statistics

  /clusters:
    get:
      operationId: getClusters
      summary: Domain clusters with cross-domain similarity
      responses:
        "200":
          description: Domain clusters

  /dashboard:
    get:
      operationId: getDashboard
      summary: Dashboard summary
      responses:
        "200":
          description: Dashboard data

  /crates/{name}:
    get:
      operationId: getCrate
      summary: Get crate metadata
      parameters:
        - name: name
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Crate metadata
        "404":
          description: Crate not found

  /openapi.json:
    get:
      operationId: getOpenApiJson
      summary: OpenAPI specification (JSON)
      responses:
        "200":
          description: OpenAPI spec as JSON

  /openapi.yaml:
    get:
      operationId: getOpenApiYaml
      summary: OpenAPI specification (YAML)
      responses:
        "200":
          description: OpenAPI spec as YAML

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    CrateInput:
      type: object
      required: [name, description, readme]
      properties:
        name:
          type: string
        description:
          type: string
        readme:
          type: string
        version:
          type: string
        domain:
          type: string
        wave:
          type: integer
        tests:
          type: integer
        loc:
          type: integer
        github_url:
          type: string
        keywords:
          type: array
          items:
            type: string
`;

/** Minimal YAML→JSON parser sufficient for the OpenAPI spec above */
function yamlToJson(yaml: string): unknown {
  const lines = yaml.split('\n');
  const root: any = {};
  const stack: Array<{ obj: any; indent: number; key?: string }> = [{ obj: root, indent: -1 }];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.search(/\S/);
    const content = line.trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];

    // List item
    if (content.startsWith('- ')) {
      const val = content.slice(2).trim();
      const arr = parent.key ? (parent.obj[parent.key] ??= []) : parent.obj;
      const parsed = parseYamlValue(val);
      if (typeof parsed === 'string' && parsed.includes(': ')) {
        // Inline map inside list
        const map: any = {};
        const [k, ...rest] = parsed.split(': ');
        map[k.trim()] = rest.join(': ').replace(/^['"]|['"]$/g, '');
        (arr as any[]).push(map);
        stack.push({ obj: map, indent: indent + 2 });
      } else {
        (arr as any[]).push(parsed);
      }
      continue;
    }

    // Key: value
    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) continue;
    const key = content.slice(0, colonIdx).trim();
    let value = content.slice(colonIdx + 1).trim();

    if (!value || value === '|' || value === '>') {
      // New object or block scalar — treat as empty object for our spec
      const child: any = {};
      if (Array.isArray(parent.obj)) {
        const last = parent.obj[parent.obj.length - 1];
        if (last && typeof last === 'object') { last[key] = child; }
      } else {
        parent.obj[key] = child;
      }
      stack.push({ obj: child, indent, key });
    } else {
      const parsed = parseYamlValue(value);
      if (Array.isArray(parent.obj)) {
        const last = parent.obj[parent.obj.length - 1];
        if (last && typeof last === 'object') last[key] = parsed;
      } else {
        parent.obj[key] = parsed;
      }
    }
  }
  return root;
}

function parseYamlValue(val: string): unknown {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?(\d+\.\d*|\.\d+)$/.test(val)) return parseFloat(val);
  if (/^\[.*\]$/.test(val)) {
    try { return JSON.parse(val); } catch { /* fall through */ }
  }
  // Strip surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  // Handle \$ref style escaped dollar signs
  return val.replace(/\\\$/g, '$');
}

// ─── Router ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // Catch JSON parse errors early for POST routes
    if (request.method === 'POST') {
      try {
        // Pre-read and cache the body so handlers can still call request.json()
        const cloned = request.clone();
        await cloned.json(); // just validates parseability
      } catch {
        return apiError('BAD_REQUEST', 'Invalid JSON in request body', 400);
      }
    }

    try {
      if (path === '/ingest' && request.method === 'POST') {
        if (!checkAuth(request, env)) return apiError('UNAUTHORIZED', 'Missing or invalid Authorization header', 401);
        return await handleIngest(request, env);
      }
      if (path === '/search' && request.method === 'POST')        return await handleSearch(request, env);
      if (path === '/similar' && request.method === 'POST')       return await handleSimilar(request, env);
      if (path === '/recommend' && request.method === 'POST')     return await handleRecommend(request, env);
      if (path === '/gap-analysis' && request.method === 'POST')  return await handleGapAnalysis(request, env);
      if (path === '/embed' && request.method === 'POST')         return await handleEmbed(request, env);
      if (path === '/stats' && request.method === 'GET')          return await handleStats(env);
      if (path === '/clusters' && request.method === 'GET')       return await handleClusters(env);
      if (path === '/dashboard' && request.method === 'GET')      return await handleDashboard(env);

      const m = path.match(/^\/crates\/(.+)$/);
      if (m && request.method === 'GET') return await handleGetCrate(m[1], env);

      // GET /docs — API documentation HTML (served from META_KV or redirect)
      if (path === '/docs' || path === '/docs/') {
        const docsHtml = await env.META_KV.get('docs:api-html');
        if (docsHtml) {
          return new Response(docsHtml, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
              ...corsHeaders,
            },
          });
        }
        // Fallback: redirect to GitHub Pages / raw
        return Response.redirect('https://superinstance.ai/docs/fleet-vector-api/', 301);
      }

      if (path === '/openapi.json' && request.method === 'GET') {
        return new Response(JSON.stringify(yamlToJson(OPENAPI_YAML), null, 2), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' },
        });
      }
      if (path === '/openapi.yaml' && request.method === 'GET') {
        return new Response(OPENAPI_YAML, {
          headers: { 'Content-Type': 'text/yaml; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' },
        });
      }

      if (path === '/health') return json({
        status: 'ok', service: 'fleet-vector-api',
        model: env.EMBEDDING_MODEL, dims: parseInt(env.EMBEDDING_DIMS || '384'),
        backend: 'vectorize', timestamp: Date.now(),
      });

      if (path === '/') return new Response(
        `Fleet Vector API\nSemantic crate intelligence via Workers AI + Vectorize\n\n` +
        `POST /ingest   POST /search   POST /similar   POST /recommend\n` +
        `POST /gap-analysis   GET /crates/:name   GET /stats   GET /clusters\n` +
        `GET /dashboard   GET /docs\n`,
        { headers: { 'Content-Type': 'text/plain' } },
      );

      return apiError('NOT_FOUND', `Endpoint not found: ${path}`, 404);
    } catch (err: any) {
      console.error(`${path}:`, err.message);
      return apiError('INTERNAL_ERROR', err.message || 'An unexpected error occurred', 500);
    }
  },
} satisfies ExportedFetchHandler<Env>;
