#!/usr/bin/env node
// classify-and-ingest.js — Classify crates by name and re-ingest with domain tags
// Usage: node scripts/classify-and-ingest.js

const BASE = 'https://fleet-vector-api.casey-digennaro.workers.dev';

const DOMAIN_PATTERNS = [
  { domain: 'ternary-compute', patterns: ['ternary', 'trit', 'balanced-ternary', 'tryte'] },
  { domain: 'conservation-math', patterns: ['conservation', 'energy', 'entropy', 'hodge', 'sheaf', 'cohomology', 'laplacian', 'symplectic', 'renormaliz'] },
  { domain: 'agent-cognition', patterns: ['agent', 'homeostasis', 'belief', 'cognition', 'persona', 'identity', 'mind', 'memory'] },
  { domain: 'fleet-ops', patterns: ['fleet', 'dispatch', 'vessel', 'bottle', 'harbor', 'construct', 'coordination', 'warden'] },
  { domain: 'music-audio', patterns: ['midi', 'music', 'chord', 'melody', 'rhythm', 'tempo', 'groove', 'swing', 'audio', 'signal', 'spectrum'] },
  { domain: 'temporal', patterns: ['tminus', 't-minus', 'temporal', 'cue', 'timer', 'clock', 'schedule', 'heartbeat'] },
  { domain: 'mathematics', patterns: ['algebra', 'calculus', 'matrix', 'vector', 'tensor', 'fourier', 'wavelet', 'ode', 'solver', 'optim', 'gradient', 'euler', 'lagrangian', 'hamiltonian'] },
  { domain: 'cryptography', patterns: ['crypto', 'lattice', 'cipher', 'hash', 'sign', 'encrypt'] },
  { domain: 'networking', patterns: ['network', 'protocol', 'websocket', 'http', 'rpc', 'bridge', 'relay'] },
  { domain: 'gpu-compute', patterns: ['cuda', 'gpu', 'vulkan', 'shader', 'mlir', 'oxide'] },
  { domain: 'testing', patterns: ['test', 'bench', 'assert', 'mock', 'fuzz'] },
  { domain: 'build-infra', patterns: ['build', 'compile', 'cargo', 'forge', 'harness', 'ci'] },
  { domain: 'data-processing', patterns: ['data', 'dataset', 'csv', 'json', 'parser', 'serde'] },
  { domain: 'game-engine', patterns: ['game', 'mud', 'room', 'quest', 'player', 'inventory'] },
  { domain: 'ui-terminal', patterns: ['tui', 'terminal', 'cli', 'prompt', 'canvas', 'display'] },
  { domain: 'machine-learning', patterns: ['neural', 'model', 'train', 'inference', 'transformer', 'embedding', 'lora'] },
  { domain: 'physics', patterns: ['physics', 'kinematic', 'collision', 'particle', 'fluid', 'tropical', 'fuzzy'] },
  { domain: 'security', patterns: ['auth', 'token', 'oauth', 'jwt', 'rate-limit', 'circuit'] },
];

function classify(name) {
  const lower = name.toLowerCase();
  let best = null, bestScore = 0;
  for (const { domain, patterns } of DOMAIN_PATTERNS) {
    let score = 0;
    for (const p of patterns) {
      if (lower.includes(p)) score += (lower.startsWith(p) ? 3 : 1);
    }
    if (score > bestScore) { bestScore = score; best = domain; }
  }
  return best;
}

async function main() {
  console.error('Fetching clusters...');
  const res = await fetch(`${BASE}/clusters`);
  const data = await res.json();
  
  // Collect all crate names from the "unknown" cluster
  const unknownCluster = data.clusters.find(c => c.domain === 'unknown');
  if (!unknownCluster) { console.error('No unknown cluster found'); return; }
  
  const crateNames = unknownCluster.crates;
  console.error(`Found ${crateNames.length} crates in 'unknown' domain`);
  
  // Fetch details for each and classify
  const toIngest = [];
  let classified = 0;
  
  for (let i = 0; i < crateNames.length; i++) {
    const name = crateNames[i];
    const domain = classify(name);
    if (!domain) continue;
    
    try {
      const crateRes = await fetch(`${BASE}/crates/${name}`);
      if (!crateRes.ok) continue;
      const crate = await crateRes.json();
      
      toIngest.push({
        name: crate.name,
        description: crate.description,
        version: crate.version,
        domain: domain,
        keywords: crate.keywords || [],
        loc: crate.loc || 0,
        tests: crate.tests || 0,
      });
      classified++;
    } catch {}
    
    if ((i + 1) % 200 === 0) console.error(`Processed ${i + 1}/${crateNames.length}...`);
  }
  
  console.error(`\nClassified: ${classified} crates`);
  console.error(`Domains assigned:`);
  const byDomain = {};
  toIngest.forEach(c => { byDomain[c.domain] = (byDomain[c.domain] || 0) + 1; });
  Object.entries(byDomain).sort((a,b) => b[1]-a[1]).forEach(([d,n]) => console.error(`  ${d}: ${n}`));
  
  if (toIngest.length === 0) { console.error('Nothing to ingest'); return; }
  
  // Ingest in batches of 50
  console.error(`\nIngesting ${toIngest.length} crates in batches...`);
  let ingested = 0;
  for (let i = 0; i < toIngest.length; i += 50) {
    const batch = toIngest.slice(i, i + 50);
    try {
      const ingestRes = await fetch(`${BASE}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crates: batch }),
      });
      const result = await ingestRes.json();
      if (result.ok) ingested += batch.length;
      else console.error(`Batch failed: ${JSON.stringify(result)}`);
    } catch (e) {
      console.error(`Batch error: ${e.message}`);
    }
    // Small delay between batches
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.error(`\nDone. Ingested: ${ingested} crates with new domain tags`);
}

main().catch(console.error);
