import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bufferPathsFor } from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnChild } from './_spawn.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-drain-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('drain writes each SSE frame as one ndjson line', async () => {
  const cup = await startFakeCup({
    frames: [
      { kind: 'chat', text: 'hello', msgId: 'm1' },
      { kind: 'chat', text: 'world', msgId: 'm2' },
    ],
  });
  const child = spawnChild('lickback-drain.mjs', [], {
    SLICC_DIR: dir,
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
  });
  const { ndjson } = bufferPathsFor('sess-1', 'chat', join(dir, 'lickback'));
  const content = await waitFor(() => {
    try {
      const c = readFileSync(ndjson, 'utf-8');
      return c.split('\n').filter(Boolean).length >= 2 ? c : null;
    } catch {
      return null;
    }
  });
  child.kill();
  await cup.close();
  const lines = content
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { kind: 'chat', text: 'hello', msgId: 'm1' },
    { kind: 'chat', text: 'world', msgId: 'm2' },
  ]);
});

test('drain exits 3 when the channel is owned by someone else (409)', async () => {
  const cup = await startFakeCup({ sseStatus: 409 });
  const child = spawnChild('lickback-drain.mjs', [], {
    SLICC_DIR: dir,
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
    LICKBACK_DRAIN_RECONNECT_MS: '20',
  });
  const code = await new Promise((r) => child.on('close', r));
  await cup.close();
  expect(code).toBe(3);
});
