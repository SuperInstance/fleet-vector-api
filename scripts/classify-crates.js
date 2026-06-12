#!/usr/bin/env node
// classify-crates.js — Assign domain labels to crates based on name/keywords/description
// Usage: node classify-crates.js > classified.json
// Then POST to /ingest with the classified crates to update their domain tags

const DOMAINS = {
  'ternary':     { patterns: ['ternary', 'trit', 'balanced-ternary', 'tryte'], domain: 'ternary-compute' },
  'conservation':{ patterns: ['conservation', 'energy', 'entropy', 'hodge', 'sheaf', 'cohomology', 'laplacian'], domain: 'conservation-math' },
  'agent':       { patterns: ['agent', 'homeostasis', 'belief', 'cognition', 'persona', 'identity'], domain: 'agent-cognition' },
  'fleet':       { patterns: ['fleet', 'dispatch', 'vessel', 'bottle', 'harbor', 'construct', 'coordination'], domain: 'fleet-ops' },
  'midi':        { patterns: ['midi', 'music', 'chord', 'melody', 'rhythm', 'tempo', 'groove', 'swing', 'audio', 'signal'], domain: 'music-audio' },
  'timing':      { patterns: ['tminus', 't-minus', 'temporal', 'cue', 'timer', 'clock', 'schedule', 'heartbeat'], domain: 'temporal-coordination' },
  'math':        { patterns: ['algebra', 'calculus', 'matrix', 'vector', 'tensor', 'fourier', 'wavelet', 'ode', 'pde', 'solver', 'optim', 'gradient'], domain: 'mathematics' },
  'crypto':      { patterns: ['crypto', 'lattice', 'cipher', 'hash', 'sign', 'encrypt'], domain: 'cryptography' },
  'network':     { patterns: ['network', 'protocol', 'websocket', 'http', 'rpc', 'grpc', 'bridge', 'relay'], domain: 'networking' },
  'storage':     { patterns: ['kv', 'store', 'cache', 'index', 'database', 'vectorize', 'embedding'], domain: 'storage' },
  'testing':     { patterns: ['test', 'bench', 'assert', 'mock', 'fixture', 'fuzz'], domain: 'testing' },
  'build':       { patterns: ['build', 'compile', 'cargo', 'forge', 'harness', 'ci'], domain: 'build-infra' },
  'security':    { patterns: ['auth', 'token', 'oauth', 'jwt', 'firewall', 'rate-limit', 'circuit-break'], domain: 'security' },
  'data':        { patterns: ['data', 'dataset', 'csv', 'json', 'parser', 'serde', 'serialize'], domain: 'data-processing' },
  'gpu':         { patterns: ['cuda', 'gpu', 'vulkan', 'metal', 'shader', 'compute-kernel', 'mlir', 'oxide'], domain: 'gpu-compute' },
  'math-phys':   { patterns: ['lagrangian', 'hamiltonian', 'symplectic', 'renormaliz', 'tropical', 'fuzzy', 'knapsack', 'euler'], domain: 'mathematical-physics' },
  'game':        { patterns: ['game', 'mud', 'room', 'map', 'quest', 'player', 'inventory'], domain: 'game-engine' },
  'ui':          { patterns: ['tui', 'terminal', 'cli', 'prompt', 'render', 'canvas', 'display'], domain: 'ui-terminal' },
  'ml':          { patterns: ['neural', 'model', 'train', 'inference', 'transformer', 'embedding', 'lora', 'fine-tun'], domain: 'machine-learning' },
};

function classifyCrate(name, description = '', keywords = []) {
  const text = `${name} ${description} ${(keywords || []).join(' ')}`.toLowerCase();
  
  let bestDomain = null;
  let bestScore = 0;
  
  for (const [, config] of Object.entries(DOMAINS)) {
    let score = 0;
    for (const pattern of config.patterns) {
      if (text.includes(pattern)) {
        // Name match is strongest signal
        if (name.toLowerCase().includes(pattern)) score += 3;
        // Keyword match is medium
        else if ((keywords || []).some(k => k.toLowerCase().includes(pattern))) score += 2;
        // Description match is weakest
        else score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = config.domain;
    }
  }
  
  return bestDomain || 'uncategorized';
}

// Fetch all crates from the API and classify
async function main() {
  const BASE = 'https://fleet-vector-api.casey-digennaro.workers.dev';
  
  console.error('Fetching dashboard...');
  const dashRes = await fetch(`${BASE}/dashboard`);
  const dash = await dashRes.json();
  console.error(`Total crates: ${dash.total_crates}`);
  
  // Get clusters to find crate names
  const clusterRes = await fetch(`${BASE}/clusters`);
  const clusters = await clusterRes.json();
  
  // Collect all crate names
  const crateNames = new Set();
  for (const [domain, crates] of Object.entries(clusters.domains || {})) {
    for (const c of (crates || [])) {
      if (c.name) crateNames.add(c.name);
    }
  }
  
  console.error(`Found ${crateNames.size} unique crate names`);
  
  // Fetch each crate's metadata and classify
  const classified = [];
  let count = 0;
  for (const name of crateNames) {
    try {
      const res = await fetch(`${BASE}/crates/${name}`);
      if (!res.ok) continue;
      const crate = await res.json();
      
      const newDomain = classifyCrate(crate.name, crate.description, crate.keywords);
      
      if (newDomain !== 'uncategorized' && newDomain !== (crate.domain || 'unknown')) {
        classified.push({
          name: crate.name,
          description: crate.description,
          version: crate.version,
          domain: newDomain,
          old_domain: crate.domain || 'unknown',
          keywords: crate.keywords || [],
          loc: crate.loc || 0,
          tests: crate.tests || 0,
        });
      }
      count++;
      if (count % 100 === 0) console.error(`Processed ${count}/${crateNames.size}...`);
    } catch (e) {
      // skip
    }
  }
  
  console.error(`\nClassified: ${classified.length} crates changed domain`);
  console.log(JSON.stringify(classified, null, 2));
}

main().catch(console.error);
