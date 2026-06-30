import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

// cup-attach is the handler's ATTACH-ONLY bring-up: it polls the bridge-ready probe
// of an already-running cup and NEVER launches one. This is what makes the handler
// structurally incapable of resurrecting a cup the operator stopped — cup lifecycle
// belongs to the dispatching/steering session.

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-attach-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('prints the base URL when the cup bridge is ready', async () => {
  const cup = await startFakeCup(); // GET /api/targets answers 200 by default
  writeFileSync(join(dir, 'cup.json'), JSON.stringify({ port: cup.port, pid: 1, startedAt: 'x' }));
  const r = await spawnScript('cup-attach.mjs', [], { SLICC_DIR: dir });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe(cup.base);
  await cup.close();
});

test('exits 1 (never launches) when no cup appears within the budget', async () => {
  writeFileSync(join(dir, 'cup.json'), JSON.stringify({ port: 1, pid: 1, startedAt: 'x' }));
  const r = await spawnScript('cup-attach.mjs', [], {
    SLICC_DIR: dir,
    SLICC_ATTACH_ATTEMPTS: '2',
    SLICC_ATTACH_INTERVAL_MS: '20',
  });
  expect(r.code).toBe(1);
  // attach-only: unlike cup-up it must NOT detect dev/prod mode or spawn a launcher.
  expect(r.stderr).not.toMatch(/mode/);
  expect(r.stderr).toMatch(/only attaches/i);
});

test('waits for the BRIDGE (targets), not just /api/status: targets 503 → not ready', async () => {
  // node-server up (/api/status ok) but the browser bridge not connected yet
  // (/api/targets 503) is NOT drivable — attach must not return it.
  const cup = await startFakeCup({ targetsStatus: 503 });
  writeFileSync(join(dir, 'cup.json'), JSON.stringify({ port: cup.port, pid: 1, startedAt: 'x' }));
  const r = await spawnScript('cup-attach.mjs', [], {
    SLICC_DIR: dir,
    SLICC_ATTACH_ATTEMPTS: '2',
    SLICC_ATTACH_INTERVAL_MS: '20',
  });
  expect(r.code).toBe(1);
  await cup.close();
});
