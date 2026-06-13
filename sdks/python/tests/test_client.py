import pytest
import responses
from fleet_vector_api import FleetVectorClient


BASE = "https://fleet-vector-api.casey-digennaro.workers.dev"


@pytest.fixture
def client():
    return FleetVectorClient()


@pytest.fixture
def authed_client():
    return FleetVectorClient(ingest_secret="test-secret")


@responses.activate
def test_search(client):
    responses.add(
        responses.POST,
        f"{BASE}/search",
        json={"results": [{"name": "tokio", "score": 0.95}]},
        status=200,
    )
    results = client.search("async runtime", top_k=5)
    assert len(results) == 1
    assert results[0]["name"] == "tokio"
    assert responses.calls[0].request.json() == {"query": "async runtime", "topK": 5}


@responses.activate
def test_recommend(client):
    responses.add(
        responses.POST,
        f"{BASE}/recommend",
        json={"recommendations": [{"name": "axum"}]},
        status=200,
    )
    recs = client.recommend("building a REST API", top_k=3)
    assert recs[0]["name"] == "axum"


@responses.activate
def test_similar(client):
    responses.add(
        responses.POST,
        f"{BASE}/similar",
        json={"similar": [{"name": "serde_json"}]},
        status=200,
    )
    results = client.similar("serde", top_k=5)
    assert results[0]["name"] == "serde_json"


@responses.activate
def test_stats(client):
    responses.add(
        responses.GET,
        f"{BASE}/stats",
        json={"totalVectors": 1012},
        status=200,
    )
    stats = client.stats()
    assert stats["totalVectors"] == 1012


@responses.activate
def test_clusters(client):
    responses.add(
        responses.GET,
        f"{BASE}/clusters",
        json={"clusters": [{"name": "web", "count": 42}]},
        status=200,
    )
    data = client.clusters()
    assert data["clusters"][0]["name"] == "web"


@responses.activate
def test_dashboard(client):
    responses.add(
        responses.GET,
        f"{BASE}/dashboard",
        json={"stats": {}, "clusters": []},
        status=200,
    )
    data = client.dashboard()
    assert "stats" in data


@responses.activate
def test_gap_analysis(client):
    responses.add(
        responses.POST,
        f"{BASE}/gap-analysis",
        json={"gaps": ["missing HTTP/3 support"]},
        status=200,
    )
    data = client.gap_analysis("web frameworks")
    assert "gaps" in data


@responses.activate
def test_gap_analysis_no_query(client):
    responses.add(
        responses.POST,
        f"{BASE}/gap-analysis",
        json={"gaps": []},
        status=200,
    )
    data = client.gap_analysis()
    assert "gaps" in data
    assert responses.calls[0].request.json() == {}


@responses.activate
def test_crate(client):
    responses.add(
        responses.GET,
        f"{BASE}/crates/tokio",
        json={"name": "tokio", "downloads": 500000000},
        status=200,
    )
    data = client.crate("tokio")
    assert data["name"] == "tokio"


@responses.activate
def test_ingest(authed_client):
    responses.add(
        responses.POST,
        f"{BASE}/ingest",
        json={"ingested": 3},
        status=200,
    )
    result = authed_client.ingest([{"name": "my-crate"}])
    assert result["ingested"] == 3
    req = responses.calls[0].request
    assert req.headers["Authorization"] == "Bearer test-secret"


@responses.activate
def test_custom_base_url():
    client = FleetVectorClient(base_url="http://localhost:8787")
    responses.add(
        responses.GET,
        "http://localhost:8787/stats",
        json={"totalVectors": 0},
        status=200,
    )
    stats = client.stats()
    assert stats["totalVectors"] == 0


@responses.activate
def test_http_error(client):
    responses.add(
        responses.GET,
        f"{BASE}/crates/nonexistent",
        json={"error": "not found"},
        status=404,
    )
    with pytest.raises(Exception):
        client.crate("nonexistent")
