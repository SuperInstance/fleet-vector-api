#!/usr/bin/env tsx
/**
 * Ingest crates from local filesystem into Fleet Vector API
 *
 * Reads each crate's Cargo.toml + README.md, POSTs to the /ingest endpoint.
 * Run locally: npm run ingest -- --api http://localhost:8787
 *
 * This is the real production pipeline:
 *   Cargo.toml (name, description, keywords) + README.md
 *     → POST /ingest
 *     → Workers AI embedding (bge-small-en-v1.5, 384-dim)
 *     → Vectorize index
 */

import { readFileSync, existsSync } from 'fs';
import { readdirSync } from 'fs';
import { join } from 'path';
import TOML from 'smol-toml'; // or parse manually

interface CrateData {
  name: string;
  description: string;
  readme: string;
  version: string;
  keywords: string[];
  github_url: string;
}

function parseCargoToml(path: string): { name: string; description: string; version: string; keywords?: string[] } | null {
  try {
    const content = readFileSync(path, 'utf-8');
    // Minimal TOML parser for [package] section
    const packageMatch = content.match(/\[package\]([\s\S]*?)(\[|$)/);
    if (!packageMatch) return null;

    const section = packageMatch[1];
    const get = (key: string): string | null => {
      const m = section.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'm'));
      return m ? m[1] : null;
    };

    const keywordsMatch = section.match(/keywords\s*=\s*\[([^\]]*)\]/);

    return {
      name: get('name') || '',
      description: get('description') || get('desc') || '',
      version: get('version') || '0.1.0',
      keywords: keywordsMatch
        ? keywordsMatch[1].split(',').map(k => k.trim().replace(/"/g, ''))
        : [],
    };
  } catch {
    return null;
  }
}

function readReadme(dir: string): string {
  for (const name of ['README.md', 'Readme.md', 'README.MD', 'README', 'readme.md']) {
    const path = join(dir, name);
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }
  return '';
}

async function main() {
  const args = process.argv.slice(2);
  const apiIdx = args.indexOf('--api');
  const reposIdx = args.indexOf('--repos');
  const apiBase = args.find(a => a.startsWith('--api='))?.split('=')[1]
    || (apiIdx >= 0 && args[apiIdx + 1] ? args[apiIdx + 1] : null)
    || 'http://localhost:8787';
  const reposDir = args.find(a => a.startsWith('--repos='))?.split('=')[1]
    || (reposIdx >= 0 && args[reposIdx + 1] ? args[reposIdx + 1] : null)
    || '/home/phoenix/repos';
  const dryRun = args.includes('--dry-run');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || Infinity;

  console.log(`Fleet Vector API — Crate Ingestion`);
  console.log(`  API: ${apiBase}`);
  console.log(`  Repos: ${reposDir}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log('');

  const dirs = readdirSync(reposDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(reposDir, d.name));

  const crates: CrateData[] = [];
  let skipped = 0;

  for (const dir of dirs) {
    const cargoPath = join(dir, 'Cargo.toml');
    if (!existsSync(cargoPath)) { skipped++; continue; }

    const pkg = parseCargoToml(cargoPath);
    if (!pkg || !pkg.name) { skipped++; continue; }

    // Skip if publish = false
    const cargoContent = readFileSync(cargoPath, 'utf-8');
    if (/publish\s*=\s*false/.test(cargoContent)) { skipped++; continue; }

    const readme = readReadme(dir);
    const dirName = dir.split('/').pop()!;

    crates.push({
      name: pkg.name,
      description: pkg.description || `${pkg.name} crate`,
      readme: readme || `${pkg.name}: ${pkg.description}`,
      version: pkg.version,
      keywords: pkg.keywords || [],
      github_url: `https://github.com/SuperInstance/${dirName}`,
    });

    if (crates.length >= limit) break;
  }

  console.log(`Found ${crates.length} crates to ingest (${skipped} skipped)`);

  if (dryRun) {
    console.log('\nFirst 5 crates:');
    crates.slice(0, 5).forEach(c => {
      console.log(`  ${c.name} v${c.version}: "${c.description.slice(0, 60)}..." (${c.readme.length} chars README, ${c.keywords.length} keywords)`);
    });
    console.log(`\nWould POST to ${apiBase}/ingest in batches of 50`);
    return;
  }

  // Ingest in batches
  const batchSize = 50;
  let ingested = 0;
  let errors = 0;

  for (let i = 0; i < crates.length; i += batchSize) {
    const batch = crates.slice(i, i + batchSize);
    console.log(`Ingesting batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(crates.length / batchSize)} (${batch.length} crates)...`);

    try {
      const response = await fetch(`${apiBase}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crates: batch }),
      });

      const result = await response.json() as any;
      ingested += result.inserted || batch.length;

      if (result.errors?.length) {
        console.error(`  ⚠️  Errors: ${result.errors.join(', ')}`);
        errors++;
      }
    } catch (err: any) {
      console.error(`  ❌ Batch failed: ${err.message}`);
      errors++;
    }

    // Rate limit: small delay between batches
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n=== Ingestion Complete ===`);
  console.log(`Ingested: ${ingested}/${crates.length}`);
  console.log(`Batch errors: ${errors}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
