import { afterEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

// lickback-stop stands the chat handler down WITHOUT stopping the cup: it POSTs
// /api/lickback/stop (which ends the handler's open SSE so its blocked wait returns
// exit 4). It replaces the channel-takeover workaround. Always exits 0.

let cup;
afterEach(async () => {
  if (cup) await cup.close();
});

test('{stopped:true} → prints the stopped message and exits 0', async () => {
  cup = await startFakeCup({ stop: { stopped: true } });
  const r = await spawnScript('lickback-stop.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/Stopped the chat handler/i);
  expect(cup.received.stops.length).toBe(1);
});

test('{stopped:false} → prints nothing-to-stop and exits 0', async () => {
  cup = await startFakeCup({ stop: { stopped: false } });
  const r = await spawnScript('lickback-stop.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/No active chat handler/i);
});

test('an unreachable cup → prints no-cup and exits 0 (never throws)', async () => {
  const r = await spawnScript('lickback-stop.mjs', [], {
    CUP_BASE: 'http://127.0.0.1:1',
    SLICC_SESSION: 'sess-1',
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/No cup reachable/i);
});

test('works without SLICC_SESSION (stop is not owner-gated) → still POSTs and exits 0', async () => {
  cup = await startFakeCup({ stop: { stopped: true } });
  const r = await spawnScript('lickback-stop.mjs', [], { CUP_BASE: cup.base });
  expect(r.code).toBe(0);
  expect(cup.received.stops.length).toBe(1);
  // A session header was still sent (the route requires its presence).
  expect(cup.received.stops[0].session).toBeTruthy();
});
