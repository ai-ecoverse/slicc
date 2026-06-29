import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-ensure-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The "no cup → launch one" path can't be integration-tested without launching a
// real cup (Chrome); its branching is covered by ensure.test.mjs. Here we assert
// the wrapper's already-live path: it must NOT launch, just print the base URL.
test('prints the base URL without launching when a cup is already live', async () => {
  const cup = await startFakeCup();
  writeFileSync(join(dir, 'cup.json'), JSON.stringify({ port: cup.port, pid: 1, startedAt: 'x' }));
  const r = await spawnScript('cup-ensure.mjs', [], { SLICC_DIR: dir });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe(cup.base);
  expect(r.stderr).not.toMatch(/Launched/);
  await cup.close();
});
