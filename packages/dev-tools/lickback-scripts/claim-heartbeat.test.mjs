import { afterEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let cup;
const env = () => ({ CUP_BASE: cup.base, SLICC_SESSION: 'sess-1' });
afterEach(async () => {
  if (cup) await cup.close();
});

test('claim exits 0 when granted', async () => {
  cup = await startFakeCup();
  const r = await spawnScript('lickback-claim.mjs', [], env());
  expect(r.code).toBe(0);
  expect(cup.received.claims[0]).toEqual({ body: { channel: 'chat' }, session: 'sess-1' });
});

test('claim exits 3 and names the owner when taken', async () => {
  cup = await startFakeCup({ claim: { status: 409, json: { owner: 'other' } } });
  const r = await spawnScript('lickback-claim.mjs', [], env());
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
  const r = await spawnScript('lickback-claim.mjs', [], { CUP_BASE: cup.base });
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/SLICC_SESSION/);
});
