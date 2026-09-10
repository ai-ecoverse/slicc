import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { type Edit, myersDiff } from '../../src/git/diff.js';

/** Independent dynamic-programming oracle, kept small enough for a full table. */
function shortestDistance(a: string[], b: string[]): number {
  const costs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) costs[i][0] = i;
  for (let j = 0; j <= b.length; j++) costs[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      costs[i][j] =
        a[i - 1] === b[j - 1]
          ? costs[i - 1][j - 1]
          : 1 + Math.min(costs[i - 1][j], costs[i][j - 1]);
    }
  }
  return costs[a.length][b.length];
}

function expectRoundTrip(edits: Edit[], a: string[], b: string[]) {
  expect(edits.filter((edit) => edit.type !== 'insert').map((edit) => edit.line)).toEqual(a);
  expect(edits.filter((edit) => edit.type !== 'delete').map((edit) => edit.line)).toEqual(b);
}

describe('myersDiff', () => {
  it('finds a shortest, lossless edit script for every pair of short binary sequences', () => {
    const inputs: string[][] = [[]];
    for (let length = 1; length <= 5; length++) {
      for (let bits = 0; bits < 2 ** length; bits++) {
        inputs.push(Array.from({ length }, (_, i) => String((bits >> i) & 1)));
      }
    }
    for (const a of inputs) {
      Object.freeze(a);
      for (const b of inputs) {
        const edits = myersDiff(a, b);
        expectRoundTrip(edits, a, b);
        expect(edits.filter((edit) => edit.type !== 'equal')).toHaveLength(shortestDistance(a, b));
      }
    }
  });

  it('handles repeated lines and uneven subproblems against an independent oracle', () => {
    let seed = 12345;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    for (let trial = 0; trial < 200; trial++) {
      const a = Array.from({ length: random(80) }, () => String(random(7)));
      const b = Array.from({ length: random(80) }, () => String(random(7)));
      const edits = myersDiff(a, b);
      expectRoundTrip(edits, a, b);
      expect(edits.filter((edit) => edit.type !== 'equal')).toHaveLength(shortestDistance(a, b));
    }
  });

  it('preserves large equal edges without overflowing the call stack', () => {
    const prefix = Array.from({ length: 100_000 }, (_, i) => `prefix-${i}`);
    const suffix = Array.from({ length: 100_000 }, (_, i) => `suffix-${i}`);
    const a = [...prefix, 'old', ...suffix];
    const b = [...prefix, 'new', ...suffix];
    const edits = myersDiff(a, b);
    expectRoundTrip(edits, a, b);
    expect(edits.filter((edit) => edit.type !== 'equal')).toEqual([
      { type: 'delete', line: 'old' },
      { type: 'insert', line: 'new' },
    ]);
  });

  it('diffs the reported input sizes with a 64 MiB heap and preserves interior matches', async () => {
    // Isolate OOM regressions from Vitest. Native TS stripping is available in
    // our minimum Node (22.18); the pure diff module has no runtime imports.
    const source = new URL('../../src/git/diff.ts', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { myersDiff } from ${JSON.stringify(source)};
      const lines = (prefix, length) => Array.from({ length }, (_, i) => prefix + i);
      const common = lines('shared-', 1024);
      const a = [...lines('old-head-', 7000), ...common, ...lines('old-tail-', 6918)];
      const b = [...lines('new-head-', 9000), ...common, ...lines('new-tail-', 9964)];
      const edits = myersDiff(a, b);
      assert.deepEqual(edits.filter(e => e.type !== 'insert').map(e => e.line), a);
      assert.deepEqual(edits.filter(e => e.type !== 'delete').map(e => e.line), b);
      assert.equal(edits.filter(e => e.type === 'equal').length, common.length);
      console.log('ok');
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--max-old-space-size=64', '--input-type=module', '--eval', script],
      { timeout: 30_000 }
    );
    expect(stdout.trim()).toBe('ok');
  }, 35_000); // A high-edit-distance search does real CPU work on loaded CI runners.
});
