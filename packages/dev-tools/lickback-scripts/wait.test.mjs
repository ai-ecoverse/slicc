import { afterEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let cup;
afterEach(async () => {
  if (cup) await cup.close();
});

// lickback-wait is the long-poll replacement for drain+buffer+next: it holds the
// cup's SSE and BLOCKS until the first frame, then prints it and exits — no polling,
// no token burn while idle. Exit 0 + frame = a message; exit 0 + empty = idle timeout
// (re-run); exit 1 = cup unreachable (stop); exit 3 = channel lost (stop).

test('blocks on the SSE, prints the first frame, exits 0', async () => {
  cup = await startFakeCup({ frames: [{ kind: 'chat', text: 'hi', msgId: 'm1' }] });
  const r = await spawnScript('lickback-wait.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
  });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout.trim())).toEqual({ kind: 'chat', text: 'hi', msgId: 'm1' });
});

test('returns PROMPTLY when an event arrives mid-block (not after the deadline)', async () => {
  // The frame lands 200ms into a 10s wait window; lickback-wait must return it right
  // away (well under the deadline), proving it blocks on the push, not a timer.
  cup = await startFakeCup({
    frameDelayMs: 200,
    frames: [{ kind: 'chat', text: 'late', msgId: 'm9' }],
  });
  const t0 = Date.now();
  const r = await spawnScript('lickback-wait.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
    LICKBACK_WAIT_MS: '10000',
  });
  const elapsed = Date.now() - t0;
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout.trim())).toEqual({ kind: 'chat', text: 'late', msgId: 'm9' });
  expect(elapsed).toBeLessThan(3000); // returned on the event, nowhere near the 10s cap
});

test('exits 3 when the channel is owned by another session (409)', async () => {
  cup = await startFakeCup({ sseStatus: 409 });
  const r = await spawnScript('lickback-wait.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
  });
  expect(r.code).toBe(3);
});

test('exits 0 with EMPTY output on idle timeout (no event before the deadline)', async () => {
  // Fake cup holds the SSE open with no frames → the wait deadline fires → clean idle
  // exit so the handler simply re-issues (one cheap turn per ~deadline, not per 30s).
  cup = await startFakeCup({});
  const r = await spawnScript('lickback-wait.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
    LICKBACK_WAIT_MS: '300',
  });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe('');
});

test('exits 1 when the cup is unreachable (handler stops)', async () => {
  const r = await spawnScript('lickback-wait.mjs', [], {
    CUP_BASE: 'http://127.0.0.1:1',
    SLICC_SESSION: 'sess-1',
    LICKBACK_WAIT_MS: '3000',
  });
  expect(r.code).toBe(1);
});
