# fleet-vector-api

**Real semantic search** across the SuperInstance ecosystem using Cloudflare Workers AI embeddings + Vectorize.

This isn't fake 32-dim hand-computed vectors. This is `@cf/baai/bge-small-en-v1.5` — a real 384-dimensional embedding model running on Cloudflare's edge network, producing embeddings that actually understand what your crates do.

## Pipeline

```
Crate README + Cargo.toml metadata
        ↓
Workers AI (bge-small-en-v1.5, 384-dim)
        ↓
Vectorize index (cosine similarity)
        ↓
Semantic search API at the edge
```

## Why This Matters

The ecosystem has 548 crates. Finding related work across domains is hard:
- "What crates use conservation laws?" → finds `conservation-law`, `entropy-lint`, `agent-homeostasis`, `hodge-belief-rs`
- "sheaf theory" → finds `persistent-sheaf`, `sheaf-cohomology`, `sheaf-agents-c`, `sheaf-coherence`
- "agent timing" → finds `agent-cadence`, `agent-rubato`, `agent-groove`, `agent-swing`

Keyword search misses cross-domain connections. Semantic embeddings catch them.

## API

### Ingest

```bash
curl -X POST http://localhost:8787/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "crates": [{
      "name": "conservation-law",
      "description": "Core invariant for constraint-aware AI systems",
      "readme": "# Conservation Law\n\nImplements γ + η = C...",
      "version": "0.2.1",
      "keywords": ["conservation", "invariant", "ternary"]
    }]
  }'
```

### Search

```bash
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{" query": "agent coordination with conservation laws", "topK": 5 }'
```

### Find Similar

```bash
curl -X POST http://localhost:8787/similar \
  -H "Content-Type: application/json" \
  -d '{"crate_name": "conservation-law", "topK": 10}'
```

### Debug Embed

```bash
curl -X POST http://localhost:8787/embed \
  -H "Content-Type: application/json" \
  -d '{"text": "ternary mathematics for agent systems"}'
# Returns: 384-dim vector, magnitude, preview
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ingest` | Ingest crate(s): README → Workers AI → Vectorize |
| `POST` | `/search` | Semantic search across all crates |
| `POST` | `/similar` | Find crates similar to a given crate |
| `GET` | `/crates/:name` | Get crate metadata + README preview |
| `GET` | `/stats` | Index statistics |
| `POST` | `/embed` | Debug: embed arbitrary text |
| `GET` | `/health` | Health check |

## Batch Ingestion

```bash
# Ingest all crates from local filesystem
npm run ingest -- --api http://localhost:8787 --repos /home/phoenix/repos

# Dry run first
npm run ingest -- --dry-run

# Limit to first 10 for testing
npm run ingest -- --limit=10
```

## Architecture Decisions

### Why bge-small-en-v1.5 (384-dim) not bge-m3 (1024-dim)?
- **Latency**: 384-dim embeddings are ~3x faster to generate at the edge
- **Cost**: Fewer dimensions = cheaper Vectorize storage
- **Accuracy**: For crate descriptions (technical English), 384-dim is sufficient
- **Upgrade path**: Swap to `@cf/baai/bge-m3` in wrangler.toml when needed

### Why CLS pooling?
Cloudflare recommends `pooling: 'cls'` for bge models — uses the [CLS] token representation which captures full-sequence semantics better than mean pooling.

### Why normalize to unit vectors?
Cosine similarity is the standard for semantic search. Unit vectors make dot product = cosine similarity, which is what Vectorize uses internally.

## Storage

| Store | Purpose | Retention |
|-------|---------|-----------|
| **Vectorize** | 384-dim embeddings + metadata | Permanent |
| **KV** | Full crate metadata JSON | 30 days (refresh on ingest) |
| **R2** | Raw README.md files | Permanent |

## Local Development

```bash
npm install
npm run dev     # Starts wrangler dev on :8787
npm test        # Run unit tests
```

## Deployment

```bash
# Create Vectorize index first
wrangler vectorize create fleet-crates --dimensions=384 --metric=cosine

# Deploy
npm run deploy
```

## License

MIT OR Apache-2.0
