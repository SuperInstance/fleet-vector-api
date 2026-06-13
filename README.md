# fleet-vector-api

A vector similarity search API for fleet embeddings. Implements brute-force cosine similarity search over in-memory vectors with metadata support. Designed for semantic crate discovery across the SuperInstance fleet — index once, query by meaning rather than keyword.

## Why It Matters

Traditional keyword search fails when queries don't share vocabulary with targets. "Rate limiting middleware" should find "throttle handler" even with zero token overlap. Vector search solves this by projecting text into a continuous embedding space where semantic proximity becomes geometric proximity. This API provides the foundational retrieval primitive: given a query vector, return the K nearest neighbors by cosine similarity.

## How It Works

### Cosine Similarity

The core metric is cosine similarity between two vectors **a** and **b** in ℝᵈ:

```
sim(a, b) = (a · b) / (‖a‖ · ‖b‖) = Σᵢ aᵢbᵢ / (√(Σᵢ aᵢ²) · √(Σᵢ bᵢ²))
```

This measures the angle between vectors, independent of magnitude. Similarity ranges from −1 (opposite) to +1 (identical).

### Brute-Force Search

For a query vector **q** and index of N vectors, the search computes:

```
scores = [(id_i, sim(q, v_i)) for i in 1..N]
top_k  = sort_desc(scores)[:k]
```

**Time complexity**:
- Per query: O(N · d) for similarity computation + O(N log N) for sorting = **O(N · d + N log N)**
- With N = 1,012 crates and d = 384 (BGE-small): ~389K multiply-adds per query

**Space complexity**: O(N · d) for the vector store.

### Why Brute Force Is Correct Here

At N ≈ 1,000 vectors, brute force is faster than approximate nearest neighbor (ANN) indices like HNSW or IVF, which add overhead that only pays off at N > 10,000. The linear scan fits in L2 cache and has no index-build cost.

### Embedding Model

The fleet uses `@cf/baai/bge-small-en-v1.5` (384-dimensional BGE embeddings) via Cloudflare Workers AI. This model produces normalized vectors, so cosine similarity reduces to dot product — but the implementation computes full cosine for safety (handles unnormalized inputs).

## Quick Start

```bash
# Build
cargo build --release

# Run demo (indexes 3 sample vectors, queries for nearest 2)
./target/release/fleet-vector-api
```

### Deployed Instance

```
POST https://fleet-vector-api.casey-digennaro.workers.dev/search
     {"query": "rate limiting", "topK": 5}

POST https://fleet-vector-api.casey-digennaro.workers.dev/ingest
     (bulk upsert crates)

GET  https://fleet-vector-api.casey-digennaro.workers.dev/stats
```

## API

### Data Structures

```rust
struct Vector {
    id: String,
    data: Vec<f32>,              // 384-dim for BGE-small
    metadata: Option<Value>,     // arbitrary JSON
}

struct SearchResult {
    id: String,
    score: f32,                  // cosine similarity ∈ [-1, 1]
}
```

### VectorIndex Methods

| Method | Signature | Complexity |
|--------|-----------|------------|
| `new(d)` | `→ VectorIndex` | O(1) |
| `insert(v)` | `&mut self` | O(1) amortized |
| `search(q, k)` | `&self → Vec<SearchResult>` | O(Nd + N log N) |

## Architecture Notes

fleet-vector-api is the **semantic memory (γ)** that enables the fleet to recall relevant crates by meaning rather than string matching. The crate registry is the **knowledge base (η)**. The retrieval quality (C) depends on embedding quality: BGE-small captures semantic similarity well enough that the γ + η = C composition produces high-precision search results. The brute-force approach is a deliberate engineering choice — at this scale, simplicity wins over index complexity.

### Scaling Path

When N exceeds ~10K, swap the brute-force `Vec<Vector>` for an HNSW index (e.g., `hnsw_rs` or `usearch`). The API surface stays identical; only the internal `search` method changes from O(Nd) to O(log N · d).

## References

- **Cosine similarity in IR**: Manning, C., Raghavan, P., Schütze, H. *Introduction to Information Retrieval.* Cambridge UP, 2008. Chapter 6.
- **BGE embeddings**: Xiao, S., et al. "C-Pack: Packaged Resources To Advance General Chinese Embedding." *SIGIR*, 2024.
- **ANN benchmarks**: Bernhardsson, E. "Ann-benchmarks: A benchmarking tool for approximate nearest neighbor search." *SISAP*, 2018.
- **Vector search at scale**: Johnson, J., Douze, M., Jégou, H. "Billion-scale similarity search with GPUs." *IEEE Transactions on Big Data*, 2021.

## License

MIT
