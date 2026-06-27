import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bufferPathsFor } from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';
import { spawnScript } from './_spawn.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-next-'));
  mkdirSync(join(dir, 'lickback'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('prints unread frames one at a time and advances the cursor', async () => {
  const { ndjson } = bufferPathsFor('sess-1', 'chat', join(dir, 'lickback'));
  writeFileSync(ndjson, '{"kind":"chat","msgId":"m1"}\n{"kind":"chat","msgId":"m2"}\n');
  const env = { SLICC_DIR: dir, SLICC_SESSION: 'sess-1' };
  const r1 = await spawnScript('lickback-next.mjs', ['--wait', '1'], env);
  expect(JSON.parse(r1.stdout.trim())).toEqual({ kind: 'chat', msgId: 'm1' });
  const r2 = await spawnScript('lickback-next.mjs', ['--wait', '1'], env);
  expect(JSON.parse(r2.stdout.trim())).toEqual({ kind: 'chat', msgId: 'm2' });
});

test('prints nothing and exits 0 on timeout when the buffer is empty', async () => {
  const r = await spawnScript('lickback-next.mjs', ['--wait', '1'], {
    SLICC_DIR: dir,
    SLICC_SESSION: 'sess-empty',
  });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe('');
});
