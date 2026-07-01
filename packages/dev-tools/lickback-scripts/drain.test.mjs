import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('drain restart preserves an un-consumed buffer instead of truncating it (F7)', async () => {
  // A prior drain delivered a frame LIVE that lickback-next never consumed: it
  // survives only in the ndjson buffer (the server queue already dequeued it). A
  // same-session drain restart must APPEND, not wipe the handoff — otherwise the
  // human's message is silently dropped and the panel spinner hangs.
  const lbDir = join(dir, 'lickback');
  mkdirSync(lbDir, { recursive: true });
  const { ndjson, cursor } = bufferPathsFor('sess-1', 'chat', lbDir);
  writeFileSync(ndjson, `${JSON.stringify({ kind: 'chat', text: 'unconsumed', msgId: 'old' })}\n`);
  writeFileSync(cursor, '0'); // lickback-next hasn't advanced past the un-consumed line
  const cup = await startFakeCup({ frames: [{ kind: 'chat', text: 'new', msgId: 'm2' }] });
  const child = spawnChild('lickback-drain.mjs', [], {
    SLICC_DIR: dir,
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
  });
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
  expect(content).not.toBeNull();
  const lines = content
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { kind: 'chat', text: 'unconsumed', msgId: 'old' },
    { kind: 'chat', text: 'new', msgId: 'm2' },
  ]);
  // Cursor left untouched so lickback-next resumes from the un-consumed frame.
  expect(readFileSync(cursor, 'utf-8')).toBe('0');
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
