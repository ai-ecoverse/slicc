import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-disc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('prints the base URL when a cup is live', async () => {
  const cup = await startFakeCup();
  writeFileSync(join(dir, 'cup.json'), JSON.stringify({ port: cup.port, pid: 1, startedAt: 'x' }));
  const r = await spawnScript('cup-discover.mjs', [], { SLICC_DIR: dir });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe(cup.base);
  await cup.close();
});

test('exits 1 with a guidance message when no cup is up', async () => {
  writeFileSync(join(dir, 'cup.json'), JSON.stringify({ port: 1, pid: 1, startedAt: 'x' }));
  const r = await spawnScript('cup-discover.mjs', [], { SLICC_DIR: dir });
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/npm run cup/);
});
