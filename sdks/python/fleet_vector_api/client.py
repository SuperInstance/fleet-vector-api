import requests
from typing import Optional, List, Dict, Any


class FleetVectorClient:
    BASE_URL = "https://fleet-vector-api.casey-digennaro.workers.dev"

    def __init__(self, base_url: Optional[str] = None, ingest_secret: Optional[str] = None):
        self.base_url = base_url or self.BASE_URL
        self.session = requests.Session()
        if ingest_secret:
            self.session.headers["Authorization"] = f"Bearer {ingest_secret}"

    def search(self, query: str, top_k: int = 10) -> List[Dict[str, Any]]:
        """Semantic search across all crates."""
        r = self.session.post(f"{self.base_url}/search", json={"query": query, "topK": top_k})
        r.raise_for_status()
        return r.json().get("results", [])

    def recommend(self, context: str, top_k: int = 10) -> List[Dict[str, Any]]:
        """Context-aware crate recommendations."""
        r = self.session.post(f"{self.base_url}/recommend", json={"context": context, "topK": top_k})
        r.raise_for_status()
        return r.json().get("recommendations", [])

    def similar(self, name: str, top_k: int = 10) -> List[Dict[str, Any]]:
        """Find crates similar to a given crate."""
        r = self.session.post(f"{self.base_url}/similar", json={"name": name, "topK": top_k})
        r.raise_for_status()
        return r.json().get("similar", [])

    def stats(self) -> Dict[str, Any]:
        """Get index statistics."""
        r = self.session.get(f"{self.base_url}/stats")
        r.raise_for_status()
        return r.json()

    def clusters(self) -> Dict[str, Any]:
        """Get crate clusters by domain."""
        r = self.session.get(f"{self.base_url}/clusters")
        r.raise_for_status()
        return r.json()

    def dashboard(self) -> Dict[str, Any]:
        """Get full dashboard data."""
        r = self.session.get(f"{self.base_url}/dashboard")
        r.raise_for_status()
        return r.json()

    def gap_analysis(self, query: Optional[str] = None) -> Dict[str, Any]:
        """Identify coverage gaps."""
        r = self.session.post(f"{self.base_url}/gap-analysis", json={"query": query} if query else {})
        r.raise_for_status()
        return r.json()

    def crate(self, name: str) -> Dict[str, Any]:
        """Get details for a specific crate."""
        r = self.session.get(f"{self.base_url}/crates/{name}")
        r.raise_for_status()
        return r.json()

    def ingest(self, crates: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Ingest new crate data (requires ingest_secret)."""
        r = self.session.post(f"{self.base_url}/ingest", json={"crates": crates})
        r.raise_for_status()
        return r.json()
