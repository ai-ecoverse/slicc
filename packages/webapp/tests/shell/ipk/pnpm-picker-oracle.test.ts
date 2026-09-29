/**
 * ipk's version picker against pnpm's. `fixtures/pnpm-picker-oracle.json`
 * holds, for each (packument, range) pair, the version pnpm 12's own picker
 * (`pick_package_from_meta`, run as wasm) chose, under npm's rule that an
 * empty deprecation message is not a deprecation. Regenerate it with
 * `fixtures/generate-pnpm-picker-oracle.mjs`; that script never runs in CI.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Packument, resolveVersion } from '../../../src/shell/ipk/registry.js';

interface OracleCase {
  packument: string;
  range: string;
  /** pnpm's pick, or null when pnpm picks nothing (ipk throws). */
  expected: string | null;
  /** Raw pnpm 12 answer, present only where it differs from `expected`. */
  pnpm12?: string | null;
}

interface Oracle {
  packuments: Record<string, Packument>;
  cases: OracleCase[];
}

const oracle = JSON.parse(
  readFileSync(new URL('./fixtures/pnpm-picker-oracle.json', import.meta.url), 'utf8')
) as Oracle;

function label(c: OracleCase): string {
  return `${c.packument}@${JSON.stringify(c.range)} → ${c.expected ?? 'nothing'}`;
}

describe('resolveVersion matches pnpm', () => {
  it('covers the synthetic edge cases and the real @ai-ecoverse/wasm-* packuments', () => {
    const names = new Set(oracle.cases.map((c) => c.packument));
    expect(names).toContain('@ai-ecoverse/wasm-zlib');
    expect([...names].filter((n) => n.startsWith('@ai-ecoverse/wasm-')).length).toBeGreaterThan(5);
    for (const key of ['zlib-shape', 'latest-below-max', 'deprecated-latest', 'prerelease']) {
      expect(names).toContain(key);
    }
  });

  it.each(oracle.cases.map((c) => [label(c), c] as const))('%s', (_label, c) => {
    const packument = oracle.packuments[c.packument];
    if (c.expected === null) {
      expect(() => resolveVersion(packument, c.range)).toThrow();
    } else {
      expect(resolveVersion(packument, c.range)).toBe(c.expected);
    }
  });

  it('diverges from pnpm 12 only on empty deprecation messages', () => {
    const divergent = oracle.cases.filter((c) => 'pnpm12' in c);
    expect(divergent.length).toBeGreaterThan(0);
    for (const c of divergent) {
      const versions = oracle.packuments[c.packument].versions;
      expect(Object.values(versions).some((v) => v.deprecated === '')).toBe(true);
    }
  });
});
