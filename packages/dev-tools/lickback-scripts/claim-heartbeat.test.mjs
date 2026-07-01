import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let cup;
let dir;
// Isolate SLICC_DIR per test: claim now reaps stale drains from `<SLICC_DIR>/lickback/
// drains` before claiming, so the suite must never read (or reap into) the real ~/.slicc.
const env = () => ({ CUP_BASE: cup.base, SLICC_SESSION: 'sess-1', SLICC_DIR: dir });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-claim-'));
});
afterEach(async () => {
  if (cup) await cup.close();
  rmSync(dir, { recursive: true, force: true });
});

test('claim exits 0 when granted', async () => {
  cup = await startFakeCup();
  const r = await spawnScript('lickback-claim.mjs', [], env());
  expect(r.code).toBe(0);
  expect(cup.received.claims[0]).toEqual({ body: { channel: 'chat' }, session: 'sess-1' });
});

test('claim exits 3 and names the owner when a live other brain holds it past the budget', async () => {
  // A persistent 409 means a live OTHER brain owns the channel (its drain wasn't reaped
  // because it's a different session). One attempt (no retry) so the test doesn't wait out
  // the real ~60s lease-tail budget; the retry path itself is covered in claim-retry.test.mjs.
  cup = await startFakeCup({ claim: { status: 409, json: { owner: 'other' } } });
  const r = await spawnScript('lickback-claim.mjs', [], {
    ...env(),
    LICKBACK_CLAIM_RETRY_ATTEMPTS: '1',
  });
  expect(r.code).toBe(3);
  expect(r.stderr).toMatch(/other/);
});

test('claim exits 1 on server error', async () => {
  cup = await startFakeCup({ claim: { status: 503, json: {} } });
  const r = await spawnScript('lickback-claim.mjs', [], env());
  expect(r.code).toBe(1);
});

test('heartbeat exits 0 renewed and 3 when lost', async () => {
  cup = await startFakeCup();
  expect((await spawnScript('lickback-heartbeat.mjs', [], env())).code).toBe(0);
  await cup.close();
  cup = await startFakeCup({ heartbeat: { status: 409, json: {} } });
  expect((await spawnScript('lickback-heartbeat.mjs', [], env())).code).toBe(3);
});

test('claim errors clearly when env is missing', async () => {
  cup = await startFakeCup();
  const r = await spawnScript('lickback-claim.mjs', [], { CUP_BASE: cup.base, SLICC_DIR: dir });
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/SLICC_SESSION/);
});
