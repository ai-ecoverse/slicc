import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveTokens } from '../../src/ui/theme-engine.js';
import type { SimplifiedSlots } from '../../src/ui/theme-types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  here,
  '../../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/theme-vectors.json'
);

interface Vector {
  name: string;
  base: 'dark' | 'light';
  slots: SimplifiedSlots;
  expected: Record<string, string>;
}

describe('theme derivation vectors (TS ↔ Swift parity)', () => {
  const vectors: Vector[] = JSON.parse(readFileSync(fixturePath, 'utf8'));

  it('has the expected vector set', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const vector of JSON.parse(readFileSync(fixturePath, 'utf8')) as Vector[]) {
    it(`reproduces "${vector.name}"`, () => {
      expect(deriveTokens(vector.slots, vector.base)).toEqual(vector.expected);
    });
  }
});
