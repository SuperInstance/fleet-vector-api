#!/usr/bin/env node
/**
 * full-classify.js — Comprehensive domain reclassification for Fleet Vector API
 *
 * Fetches all crates from /clusters, classifies each by name using pattern matching,
 * and outputs a JSON file with {name, old_domain, new_domain} for all crates.
 */

const API = 'https://fleet-vector-api.casey-digennaro.workers.dev';
const fs = require('fs');
const path = require('path');

// ─── Classification Rules ────────────────────────────────────────────────────
// Each rule: { pattern: RegExp, domain: string }
// Evaluated in order; first match wins.

const rules = [
  // ── Prefix-based (most specific first) ──
  { pattern: /^ternary-/, domain: 'ternary-compute' },
  { pattern: /^fleet-/, domain: 'fleet-ops' },
  { pattern: /^superinstance-/, domain: 'build-infra' },
  { pattern: /^tminus-/, domain: 'temporal' },
  { pattern: /^openmind-/, domain: 'agent-cognition' },
  { pattern: /^open-mind-/, domain: 'agent-cognition' },
  { pattern: /^conservation-/, domain: 'conservation-math' },
  { pattern: /^agent-/, domain: 'agent-cognition' },

  // ── Subject-area keywords (order matters — more specific first) ──
  // Music/audio
  { pattern: /midi|music|audio|timbre|tempo|rhythm|polyrhythm|melody|harmonic|phrasing|intonation|overtone|rubato|fermata|groove|swing|jam|riff|cadence|contrapuntal|counterpoint|voice-leading|orchestration|ensemble|choir|transcription|venue|cadence|needledrop|tidelight|tidepool|crossfader|vu|ear-training|ear\b|temperament|staccato|legato|anacrusis/, domain: 'music-audio' },

  // Cryptography
  { pattern: /crypt|cipher|aes-|chacha|blake2|argon2|ecdsa|ed25519|bip32|bip44|dh-group|hmac|sha[0-9]|x509|tls-|ssl-|certificate|secret-share|zkp|zero.?knowledge/, domain: 'cryptography' },

  // Security
  { pattern: /security|audit.?log|audit.?trail|compliance|credential.?store|vault|auth|cors|csrf|sanitiz|waf|firewall|rate.?limit|threat|vulnerab|pen.?test/, domain: 'security' },

  // GPU compute
  { pattern: /cuda|gpu|wgpu|vulkan|opencl|shader|kernel.?launch|thread.?block|warp.?block|grid.?launch|surface.?memory|texture.?memory|register.?file|stream.?multiprocessor|bf16|tensor.?core|compute.?shader/, domain: 'gpu-compute' },

  // Machine learning
  { pattern: /neural|tensor\b|transformer|attention|gradient|loss|optimizer|batch.?norm|dropout|activation|classifier|regression|logistic|svm|knn|pca|bayesian|inference|model|llm|embedding|tokenizer|language.?model|backprop|epoch|training|dataset|label|feature|predict|perceptron|deep.?learn|reinforce|reward|policy|q.?value/, domain: 'machine-learning' },

  // Mathematics
  { pattern: /algebra|topology|manifold|homology|cohomology|sheaf|homotopy|fibre|bundle|stein|variety|morse|leray|serre|atiyah|chern|pontryagin|euler|betti|spectral|sequence|hodge|laplacian|differential.?form|de.?rham|cech|eilenberg|maclane|characteristic.?class|cup.?product|cobordism|dirac.?operator|banach|hilbert|cauchy|chebyshev|fourier|haar|walsh|wavelet|calculus|theorem|proof|lemma|proposition|conjecture|integral|differential|stokes|gauss|jordan|eigen|symplectic|renormalization|noether|berry.?phase|hamiltonian|lagrangian|topological|dunce.?hat|borsuk|ulam|alexander|duality|atiyah|singer|dehn|surgery|whitney|embedding|albanese|variety|cats.?theorem|catalan|number|borel|sigma|carleman|categorical.?quantum|differential|isomorphism|ring\b|group.?theory|field.?theory|gauge.?theory|chernoff|bound|pareto|markov|kalman|bayes|viterbi|baum.?welch|ising|kuramoto|percolat|epidemic|brownian|motion|diffusion|dirichlet|process|lotka|volterra|fitness|darwin|evolution|genetic|genome|popgen|sandpile|game.?of.?life|cellular.?automat|automaton|life\b|collatz/, domain: 'mathematics' },

  // Physics
  { pattern: /physics|thermodynamic|energy|electromagnetism|quantum|mechanic|entropy|conservation.?law|symplectic|map|flux\b|field\b|gauge|lattice|gauge|hamiltonian|free.?energy|ising|kuramoto|brownian|drift|ecology|dial.?ecology/, domain: 'physics' },

  // Networking
  { pattern: /dns|tcp|udp|http|websocket|socket|proxy|router|routing|packet|protocol|mtu|congestion|backpressure|channel|broadcast|mpmc|mpsc|load.?balancer|gateway|cdn|edge|mesh|sdn|nat|firewall|ip.?table|traffic|bandwidth|latency|ping|traceroute|peer|gossip|epidemic/, domain: 'networking' },

  // Temporal
  { pattern: /tminus|chrono|temporal|time|timer|schedule|cron|calendar|clock|epoch|deadline|ttl|expire|duration|interval|watch|tick|heartbeat|alarm|periodic/, domain: 'temporal' },

  // Testing
  { pattern: /test|bench|fuzz|mock|stub|spy|assert|expect|should|harness|snapshot|coverage|gap|regression|proptest|quickcheck|verify|lint|check|ci\b|assert|junit|tap/, domain: 'testing' },

  // Build infra
  { pattern: /build|cargo|crate|publish|version|release|changelog|dep|dependency|package|npm|registry|compile|artifact|deploy|rollback|container|docker|image|base.?image|toolchain|target|cross.?compil/, domain: 'build-infra' },

  // Game engine
  { pattern: /game|ecs|sprite|render|canvas|physics.?engine|collision|scene|entity|component|system\b|asset|input|joystick|controller|level|quest|dialog|character|encounter|sheet|arc\b|backgammon|chess|cribbage|dice/, domain: 'game-engine' },

  // UI/Terminal
  { pattern: /terminal|tui|cli|prompt|input|output|display|render|canvas|window|widget|component|layout|style|theme|color|font|icon|menu|toolbar|dashboard|table|list|tree.?view|form|button|modal|toast|notification|progress|spinner|zookeeper/, domain: 'ui-terminal' },

  // Data processing
  { pattern: /etl|pipeline|stream|batch|queue|kafka|flink|spark|hadoop|parquet|avro|protobuf|capnp|json|xml|yaml|toml|csv|parser|serializer|deserializer|codec|encode|decode|compress|decompress|archive|zip|tar|zlib|format|columnar|document.?store|search.?index|index|invert|doc\b|schema|migration|crdt|event.?sourc|cqrs|data.?lake|warehouse|olap|oltp/, domain: 'data-processing' },

  // Agent cognition (catch remaining agent/actor patterns)
  { pattern: /actor|agent|persona|mind|memory|consciousness|dream|cognition|perception|belief|intent|knowledge|learning|adapt|evolve|metamorphosis|phase.?change|speciation|semiosis|anacrusis|audience|self.?rivalry|homeostasis/, domain: 'agent-cognition' },

  // Conservation math (catch remaining)
  { pattern: /conservation|entropy|fold.?entropy|energy.?budget|symplectic|sheaf|coherence|hodge|renormalization|laplacian|anti.?entropy/, domain: 'conservation-math' },

  // Fleet ops (catch remaining fleet/construct/vessel patterns)
  { pattern: /construct|vessel|fleet|warden|conductor|coordinator|mapper|scanner|dispatcher|bridge|fanout|budget|dedup|health|event.?router|ssa|plato|jetsonclaw/, domain: 'fleet-ops' },

  // Ternary (catch remaining ternary references)
  { pattern: /ternary|trit|tryte|balanced.?ternary|unbalanced.?ternary/, domain: 'ternary-compute' },

  // ── Suffix-based ──
  { pattern: /-rs$/, domain: 'rust-ecosystem' },
  { pattern: /-py$/, domain: 'python-bindings' },

  // ── Pattern-based domains (consolidate small _pattern domains) ──
  { pattern: /_pattern$/, domain: 'build-infra' },
  { pattern: /_harness$/, domain: 'testing' },

  // ── Data structures & algorithms (broad) ──
  { pattern: /tree|heap|graph|sort|search|hash|map|set|queue|stack|ring|buffer|pool|cache|alloc|btree|avl|red.?black|splay|trie|suffix|array|matrix|vector|list|deque|skip.?list|linked|bloom|filter|cuckoo|sketch|count.?min|hyperloglog|disjoint.?set|union.?find|segment|fenwick|indexed|binary|fibonacci/, domain: 'mathematics' },

  // ── Distributed systems ──
  { pattern: /consensus|raft|paxos|byzantine|replica|shard|partition|split|merge|distributed|federated|cluster|node|leader|election|quorum|vote|atomic|commit|two.?phase|three.?phase|saga|compensat|idempotent|dedup/, domain: 'networking' },

  // ── Config & observability ──
  { pattern: /config|metric|trace|span|log\b|telemetry|prometheus|grafana|opentelemetry|monitor|alert|health|status|dashboard|analytics|stat|counter|gauge|histogram/, domain: 'build-infra' },

  // ── Misc patterns ──
  { pattern: /deno\b|deno_/, domain: 'build-infra' },
  { pattern: /wasm|web.?assembly/, domain: 'build-infra' },
  { pattern: /bpf|ebpf/, domain: 'security' },
  { pattern: /sensor|adc|gpio|i2c|spi|uart|embedded|esp32|jetson/, domain: 'hardware-io' },
  { pattern: /actor|mailbox|supervisor|dispatcher/, domain: 'agent-cognition' },
  { pattern: /diff|merge|patch|blame/, domain: 'build-infra' },
  { pattern: /doc|documentation|render|generator|indexer|search/, domain: 'build-infra' },
  { pattern: /api|rest|graphql|grpc|rpc|endpoint/, domain: 'networking' },
  { pattern: /async|await|future|promise|tokio|runtime|executor|spawn/, domain: 'rust-ecosystem' },
];

/**
 * Classify a single crate name into a domain.
 * Returns the matched domain or 'unknown' if no rule matches.
 */
function classify(name) {
  const lower = name.toLowerCase();
  for (const rule of rules) {
    if (rule.pattern.test(lower)) {
      return rule.domain;
    }
  }
  return 'unknown';
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('📡 Fetching all crates from /clusters...');
  const res = await fetch(`${API}/clusters`);
  const data = await res.json();

  const allCrates = [];
  for (const cluster of data.clusters) {
    for (const name of cluster.crates) {
      allCrates.push({ name, old_domain: cluster.domain });
    }
  }

  console.log(`📦 Found ${allCrates.length} crates across ${data.clusters.length} clusters\n`);

  // Classify each crate
  const results = allCrates.map(crate => ({
    name: crate.name,
    old_domain: crate.old_domain,
    new_domain: classify(crate.name),
  }));

  // ── Statistics ──
  const stats = {
    total: results.length,
    changed: 0,
    unchanged: 0,
    moved_from_unknown: 0,
    new_distribution: {},
    old_distribution: {},
    domain_changes: {},
  };

  for (const r of results) {
    // Distribution counts
    stats.new_distribution[r.new_domain] = (stats.new_distribution[r.new_domain] || 0) + 1;
    stats.old_distribution[r.old_domain] = (stats.old_distribution[r.old_domain] || 0) + 1;

    if (r.old_domain !== r.new_domain) {
      stats.changed++;
      const key = `${r.old_domain} → ${r.new_domain}`;
      stats.domain_changes[key] = (stats.domain_changes[key] || 0) + 1;
      if (r.old_domain === 'unknown') {
        stats.moved_from_unknown++;
      }
    } else {
      stats.unchanged++;
    }
  }

  // ── Report ──
  console.log('═══════════════════════════════════════════');
  console.log('  CLASSIFICATION RESULTS');
  console.log('═══════════════════════════════════════════\n');

  console.log(`Total crates:        ${stats.total}`);
  console.log(`Changed domain:      ${stats.changed}`);
  console.log(`Unchanged:           ${stats.unchanged}`);
  console.log(`Moved from unknown:  ${stats.moved_from_unknown}\n`);

  console.log('── NEW DOMAIN DISTRIBUTION ──');
  const sortedNew = Object.entries(stats.new_distribution).sort((a, b) => b[1] - a[1]);
  for (const [domain, count] of sortedNew) {
    const old = stats.old_distribution[domain] || 0;
    const diff = count - old;
    const arrow = diff > 0 ? `(+${diff})` : diff < 0 ? `(${diff})` : '';
    console.log(`  ${domain.padEnd(25)} ${String(count).padStart(5)}  ${arrow}`);
  }

  console.log('\n── TOP DOMAIN CHANGES ──');
  const sortedChanges = Object.entries(stats.domain_changes).sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [change, count] of sortedChanges) {
    console.log(`  ${change.padEnd(45)} ${count}`);
  }

  // Still unknown?
  const stillUnknown = results.filter(r => r.new_domain === 'unknown');
  if (stillUnknown.length > 0) {
    console.log(`\n── STILL UNKNOWN (${stillUnknown.length}) ──`);
    console.log(stillUnknown.map(r => r.name).sort().join(', '));
  }

  // ── Write output ──
  const output = {
    generated_at: new Date().toISOString(),
    statistics: stats,
    classifications: results,
  };

  const outPath = path.join(__dirname, '..', 'classification-results.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Results written to ${outPath}`);
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
