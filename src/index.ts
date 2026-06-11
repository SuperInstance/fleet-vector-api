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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

/** POST /ingest — Embed crates and insert into Vectorize */
async function handleIngest(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { crates?: CrateInput[] } | CrateInput;
  const crates = Array.isArray(body) ? body : ('crates' in body ? body.crates! : [body]);
  if (!crates.length) return json({ error: 'No crates' }, 400);
  if (crates.length > 50) return json({ error: 'Max 50 per request' }, 400);

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
  if (!query) return json({ error: 'Query required' }, 400);

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
  const { crate_name, topK = 10 } = await request.json() as { crate_name: string; topK?: number };
  const metaRaw = await env.META_KV.get(`crate:${crate_name}`);
  if (!metaRaw) return json({ error: `Not found: ${crate_name}` }, 404);

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
  if (!raw) return json({ error: `Not found: ${name}` }, 404);
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

/** POST /embed — Debug */
async function handleEmbed(request: Request, env: Env): Promise<Response> {
  const { text } = await request.json() as { text: string };
  if (!text) return json({ error: 'Text required' }, 400);
  const vector = await embedText(text, env.AI, env.EMBEDDING_MODEL);
  return json({
    text: text.slice(0, 200), model: env.EMBEDDING_MODEL,
    dimensions: vector.length,
    vector_preview: vector.slice(0, 10),
    magnitude: Math.sqrt(vector.reduce((s, v) => s + v * v, 0)),
  });
}

// ─── Router ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
      if (path === '/ingest' && request.method === 'POST')   return await handleIngest(request, env);
      if (path === '/search' && request.method === 'POST')   return await handleSearch(request, env);
      if (path === '/similar' && request.method === 'POST')  return await handleSimilar(request, env);
      if (path === '/embed' && request.method === 'POST')    return await handleEmbed(request, env);
      if (path === '/stats' && request.method === 'GET')     return await handleStats(env);

      const m = path.match(/^\/crates\/(.+)$/);
      if (m && request.method === 'GET') return await handleGetCrate(m[1], env);

      if (path === '/health') return json({
        status: 'ok', service: 'fleet-vector-api',
        model: env.EMBEDDING_MODEL, dims: parseInt(env.EMBEDDING_DIMS || '384'),
        backend: 'vectorize', timestamp: Date.now(),
      });

      if (path === '/') return new Response(
        `Fleet Vector API\nReal semantic search via Workers AI + Vectorize\n\n` +
        `POST /ingest   POST /search   POST /similar   GET /crates/:name   GET /stats\n`,
        { headers: { 'Content-Type': 'text/plain' } },
      );

      return json({ error: 'Not Found' }, 404);
    } catch (err: any) {
      console.error(`${path}:`, err.message);
      return json({ error: err.message }, 500);
    }
  },
} satisfies ExportedFetchHandler<Env>;
