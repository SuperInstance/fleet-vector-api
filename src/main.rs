use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct Vector {
    id: String,
    data: Vec<f32>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug)]
struct SearchResult {
    id: String,
    score: f32,
}

struct VectorIndex {
    vectors: Vec<Vector>,
    dim: usize,
}

impl VectorIndex {
    fn new(dim: usize) -> Self {
        Self { vectors: Vec::new(), dim }
    }

    fn insert(&mut self, v: Vector) {
        self.vectors.push(v);
    }

    fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm_a == 0.0 || norm_b == 0.0 { 0.0 } else { dot / (norm_a * norm_b) }
    }

    fn search(&self, query: &[f32], top_k: usize) -> Vec<SearchResult> {
        let mut scores: Vec<_> = self.vectors.iter()
            .map(|v| (v.id.clone(), Self::cosine_similarity(query, &v.data)))
            .collect();
        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        scores.into_iter().take(top_k)
            .map(|(id, score)| SearchResult { id, score })
            .collect()
    }
}

fn main() {
    let mut index = VectorIndex::new(3);
    index.insert(Vector { id: "v1".into(), data: vec![1.0, 0.0, 0.0], metadata: None });
    index.insert(Vector { id: "v2".into(), data: vec![0.0, 1.0, 0.0], metadata: None });
    index.insert(Vector { id: "v3".into(), data: vec![0.9, 0.1, 0.0], metadata: None });

    let query = vec![1.0, 0.0, 0.0];
    let results = index.search(&query, 2);
    for r in results {
        println!("{}: {:.4}", r.id, r.score);
    }
}
