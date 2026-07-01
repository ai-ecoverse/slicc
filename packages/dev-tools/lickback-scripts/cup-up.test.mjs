import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-cupup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The dev/prod launch branches spawn wrangler + Chrome and can't run in CI; the decision
// (`cupLaunchMode`) and the readiness probes are unit-tested in cup-dev.test.mjs. Here:
// the already-DRIVABLE path — a cup whose /api/targets answers ok must print the base URL
// and return BEFORE any mode detection / wrangler / launch.
test('prints the base URL when the cup bridge is already ready (no launch, no mode line)', async () => {
  const cup = await startFakeCup(); // answers GET /api/targets 200 by default
  writeFileSync(join(dir, 'cup.json'), JSON.stringify({ port: cup.port, pid: 1, startedAt: 'x' }));
  const r = await spawnScript('cup-up.mjs', [], { SLICC_DIR: dir });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe(cup.base);
  expect(r.stderr).not.toMatch(/mode/); // returned before mode detection / launch
  await cup.close();
});
