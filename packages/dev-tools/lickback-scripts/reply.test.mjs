import { afterEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let cup;
afterEach(async () => {
  if (cup) await cup.close();
});

test('sends a delta frame then a done terminator', async () => {
  cup = await startFakeCup();
  const r = await spawnScript(
    'lickback-reply.mjs',
    ['m1'],
    { CUP_BASE: cup.base, SLICC_SESSION: 'sess-1' },
    { stdin: 'here is the answer\n' }
  );
  expect(r.code).toBe(0);
  expect(cup.received.replies.map((x) => x.body)).toEqual([
    { channel: 'chat', replyTo: 'm1', delta: 'here is the answer' },
    { channel: 'chat', replyTo: 'm1', done: true },
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
