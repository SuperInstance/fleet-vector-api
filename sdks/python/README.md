# Fleet Vector API — Python SDK

Semantic search and crate recommendations powered by vector embeddings.

## Install

```bash
pip install fleet-vector-api
```

## Quick Start

```python
from fleet_vector_api import FleetVectorClient

client = FleetVectorClient()

# Semantic search
results = client.search("async runtime for Tokio", top_k=5)
for r in results:
    print(r["name"], r.get("score", 0))

# Get crate details
crate = client.crate("tokio")
print(crate)

# Find similar crates
similar = client.similar("serde", top_k=5)

# Context-aware recommendations
recs = client.recommend("building a REST API with Axum", top_k=5)

# Index stats
stats = client.stats()
print(f"Indexed: {stats.get('totalVectors', 0)} crates")

# Dashboard overview
dashboard = client.dashboard()

# Gap analysis
gaps = client.gap_analysis("web framework ecosystem")

# Cluster overview
clusters = client.clusters()
```

## Authentication

Pass an ingest secret for write operations:

```python
client = FleetVectorClient(ingest_secret="your-secret")
client.ingest([{"name": "my-crate", "description": "..."}])
```

## Custom Base URL

```python
client = FleetVectorClient(base_url="http://localhost:8787")
```

## Running Tests

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT
