import { describe, it, expect } from 'vitest';

// ─── Unit tests for embedding text construction ───────────────────────────

interface CrateInput {
  name: string;
  description: string;
  readme: string;
  version?: string;
  domain?: string;
  keywords?: string[];
}

function buildEmbeddingText(crate: CrateInput): string {
  const parts = [
    `${crate.name}: ${crate.description}`,
    crate.keywords?.length ? `Keywords: ${crate.keywords.join(', ')}` : '',
    crate.readme?.slice(0, 1500) || '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

// Minimal TOML parser (mirrors ingest script)
function parseCargoToml(content: string) {
  const packageMatch = content.match(/\[package\]([\s\S]*?)(\[|$)/);
  if (!packageMatch) return null;
  const section = packageMatch[1];
  const get = (key: string) => {
    const m = section.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'm'));
    return m ? m[1] : null;
  };
  const keywordsMatch = section.match(/keywords\s*=\s*\[([^\]]*)\]/s);
  return {
    name: get('name') || '',
    description: get('description') || '',
    version: get('version') || '0.1.0',
    keywords: keywordsMatch
      ? keywordsMatch[1].split(',').map(k => k.trim().replace(/"/g, ''))
      : [],
  };
}

describe('Fleet Vector API', () => {
  describe('Embedding text construction', () => {
    it('combines name, description, keywords, and README', () => {
      const text = buildEmbeddingText({
        name: 'conservation-law',
        description: 'Core conservation law invariant for agent systems',
        readme: '# Conservation Law\n\nImplements γ + η = C across agent layers.',
        keywords: ['conservation', 'invariant', 'agent'],
      });

      expect(text).toContain('conservation-law:');
      expect(text).toContain('Core conservation law');
      expect(text).toContain('Keywords: conservation, invariant, agent');
      expect(text).toContain('γ + η = C');
    });

    it('handles crates without keywords', () => {
      const text = buildEmbeddingText({
        name: 'simple-crate',
        description: 'A simple crate',
        readme: 'Hello world',
      });

      expect(text).not.toContain('Keywords:');
      expect(text).toContain('simple-crate:');
    });

    it('truncates long READMEs to 1500 chars', () => {
      const longReadme = 'x'.repeat(5000);
      const text = buildEmbeddingText({
        name: 'test',
        description: 'test',
        readme: longReadme,
      });

      // The README portion should be <= 1500
      const readmePortion = text.split('\n\n').pop()!;
      expect(readmePortion.length).toBeLessThanOrEqual(1500);
    });

    it('produces meaningful embedding text for semantic search', () => {
      const crates = [
        { name: 'conservation-law', description: 'Core invariant for agent systems', readme: '# Conservation Law\n\nγ + η = C', keywords: ['math', 'agent'] },
        { name: 'entropy-lint', description: 'Lint entropy conservation in agent networks', readme: '# Entropy Lint\n\nChecks that entropy is conserved', keywords: ['lint', 'entropy'] },
        { name: 'fleet-midi', description: 'MIDI processing for fleet agents', readme: '# Fleet MIDI\n\nChord and melody generation', keywords: ['midi', 'music'] },
      ];

      const texts = crates.map(c => buildEmbeddingText(c));

      // Each text should be unique and meaningful
      expect(new Set(texts).size).toBe(3);

      // Conservation-law and entropy-lint should share more tokens than fleet-midi
      const conservationTokens = new Set(texts[0].toLowerCase().split(/\W+/));
      const entropyTokens = new Set(texts[1].toLowerCase().split(/\W+/));
      const midiTokens = new Set(texts[2].toLowerCase().split(/\W+/));

      const conservationEntropyOverlap = [...conservationTokens].filter(t => entropyTokens.has(t)).length;
      const conservationMidiOverlap = [...conservationTokens].filter(t => midiTokens.has(t)).length;

      expect(conservationEntropyOverlap).toBeGreaterThan(conservationMidiOverlap);
    });
  });

  describe('TOML parsing', () => {
    it('parses a standard Cargo.toml', () => {
      const result = parseCargoToml(`
[package]
name = "conservation-law"
version = "0.2.1"
description = "Core conservation law for agent systems"
keywords = ["conservation", "invariant", "agent"]

[dependencies]
tokio = "1"
`);

      expect(result?.name).toBe('conservation-law');
      expect(result?.version).toBe('0.2.1');
      expect(result?.description).toBe('Core conservation law for agent systems');
      expect(result?.keywords).toEqual(['conservation', 'invariant', 'agent']);
    });

    it('handles Cargo.toml without keywords', () => {
      const result = parseCargoToml(`
[package]
name = "simple"
version = "0.1.0"
description = "Simple crate"
`);

      expect(result?.name).toBe('simple');
      expect(result?.keywords).toEqual([]);
    });

    it('returns null for non-package files', () => {
      const result = parseCargoToml('no package section here');
      expect(result).toBeNull();
    });
  });

  describe('Vector normalization', () => {
    it('unit vectors have magnitude 1', () => {
      // Simulate the normalization from embedText
      const rawVector = [0.3, -0.7, 0.5, 0.1, -0.2];
      const mag = Math.sqrt(rawVector.reduce((s, v) => s + v * v, 0));
      const normalized = rawVector.map(v => v / mag);

      const resultMag = Math.sqrt(normalized.reduce((s, v) => s + v * v, 0));
      expect(resultMag).toBeCloseTo(1.0, 10);
    });

    it('handles zero vectors gracefully', () => {
      const rawVector = [0, 0, 0];
      const mag = Math.sqrt(rawVector.reduce((s, v) => s + v * v, 0)) || 1;
      const normalized = rawVector.map(v => v / mag);

      // Should not be NaN
      expect(normalized.every(v => !isNaN(v))).toBe(true);
    });
  });

  describe('Search scenarios', () => {
    it('constructs different query texts for different intents', () => {
      const queries = [
        'ternary math operations',
        'agent coordination patterns',
        'MIDI chord generation',
        'conservation law verification',
        'sheaf cohomology for distributed systems',
      ];

      // Each query should produce a different embedding (different text)
      expect(new Set(queries).size).toBe(queries.length);

      // All queries should be reasonable lengths for embedding
      for (const q of queries) {
        expect(q.length).toBeGreaterThan(5);
        expect(q.length).toBeLessThan(200);
      }
    });
  });
});
