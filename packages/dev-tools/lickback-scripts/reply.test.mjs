import { afterEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let cup;
afterEach(async () => {
  if (cup) await cup.close();
});

test('sends the whole answer as one atomic done frame', async () => {
  cup = await startFakeCup();
  const r = await spawnScript(
    'lickback-reply.mjs',
    ['m1'],
    { CUP_BASE: cup.base, SLICC_SESSION: 'sess-1' },
    { stdin: 'here is the answer\n' }
  );
  expect(r.code).toBe(0);
  // F8: one POST, not delta-then-done — atomic delivery.
  expect(cup.received.replies.map((x) => x.body)).toEqual([
    { channel: 'chat', replyTo: 'm1', text: 'here is the answer', done: true },
  ]);
});

test('still sends a done terminator for empty text', async () => {
  cup = await startFakeCup();
  const r = await spawnScript(
    'lickback-reply.mjs',
    ['m2'],
    { CUP_BASE: cup.base, SLICC_SESSION: 'sess-1' },
    { stdin: '' }
  );
  expect(r.code).toBe(0);
  expect(cup.received.replies.map((x) => x.body)).toEqual([
    { channel: 'chat', replyTo: 'm2', done: true },
  ]);
});

test('exits 1 atomically when the reply POST fails — nothing half-rendered', async () => {
  // F8 regression: the old delta-then-done pair could land the delta then fail
  // the terminator, hanging the spinner. With one atomic frame a failure means
  // the panel rendered nothing at all (no orphaned bubble, no stuck spinner).
  cup = await startFakeCup({ reply: { status: 503, json: { error: 'down' } } });
  const r = await spawnScript(
    'lickback-reply.mjs',
    ['m3'],
    { CUP_BASE: cup.base, SLICC_SESSION: 'sess-1' },
    { stdin: 'partial?' }
  );
  expect(r.code).toBe(1);
  // Exactly one POST was attempted (the atomic frame), and it failed — there is
  // no second "done" POST that could have leaked a half-delivered turn.
  expect(cup.received.replies.length).toBe(1);
});

test('exits 1 when msgId is missing', async () => {
  cup = await startFakeCup();
  const r = await spawnScript(
    'lickback-reply.mjs',
    [],
    { CUP_BASE: cup.base, SLICC_SESSION: 'sess-1' },
    { stdin: 'x' }
  );
  expect(r.code).toBe(1);
});
