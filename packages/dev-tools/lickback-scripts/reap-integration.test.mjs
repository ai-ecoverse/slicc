// Integration: the real drain + claim scripts wired to the reaper. A drain
// advertises a port-scoped pidfile while it runs and clears it on exit; a fresh
// claim reaps a prior session's live drain on the SAME cup before claiming, but
// never touches a parallel cup's drain. Spawns real child processes (like
// drain.test.mjs) so the fs/process wiring is exercised end to end.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  drainPidfileName,
  drainsDir,
} from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnChild, spawnScript } from './_spawn.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-reap-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await new Promise((r) => setTimeout(r, 30));
  }
};
const pidfileFor = (cupPort, pid) =>
  join(drainsDir(join(dir, 'lickback')), drainPidfileName(cupPort, pid));
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('drain writes a port-scoped pidfile on start and removes it on exit', async () => {
  const cup = await startFakeCup({ frames: [{ kind: 'chat', text: 'hi', msgId: 'm1' }] });
  const child = spawnChild('lickback-drain.mjs', [], {
    SLICC_DIR: dir,
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-1',
  });
  const pidfile = pidfileFor(cup.port, child.pid);
  expect(await waitFor(() => existsSync(pidfile))).toBe(true);
  expect(readFileSync(pidfile, 'utf-8')).toBe(String(child.pid));
  child.kill('SIGTERM');
  const gone = await waitFor(() => !existsSync(pidfile));
  await cup.close();
  expect(gone).toBe(true);
});

test('claim reaps a live same-cup drain before claiming', async () => {
  const cup = await startFakeCup(); // claim → 200 by default; SSE stays open
  const oldDrain = spawnChild('lickback-drain.mjs', [], {
    SLICC_DIR: dir,
    CUP_BASE: cup.base,
    SLICC_SESSION: 'old-sess',
  });
  const pidfile = pidfileFor(cup.port, oldDrain.pid);
  expect(await waitFor(() => existsSync(pidfile))).toBe(true);
  const oldDrainClosed = new Promise((r) => oldDrain.on('close', r));

  // A NEW brain claims the same cup — it must reap the old drain first.
  const r = await spawnScript('lickback-claim.mjs', [], {
    SLICC_DIR: dir,
    CUP_BASE: cup.base,
    SLICC_SESSION: 'new-sess',
  });
  await oldDrainClosed; // the old drain was killed by the reaper
  await cup.close();
  expect(r.code).toBe(0); // claim granted
  expect(existsSync(pidfile)).toBe(false); // its pidfile was reaped
});

test('claim for one cup does NOT reap a drain bound to a different cup', async () => {
  const cupA = await startFakeCup();
  const cupB = await startFakeCup();
  const drainB = spawnChild('lickback-drain.mjs', [], {
    SLICC_DIR: dir,
    CUP_BASE: cupB.base,
    SLICC_SESSION: 'b-sess',
  });
  const pidfileB = pidfileFor(cupB.port, drainB.pid);
  expect(await waitFor(() => existsSync(pidfileB))).toBe(true);

  // Claim against cup A must leave cup B's drain (different port) untouched.
  const r = await spawnScript('lickback-claim.mjs', [], {
    SLICC_DIR: dir,
    CUP_BASE: cupA.base,
    SLICC_SESSION: 'a-sess',
  });
  expect(r.code).toBe(0);
  await new Promise((res) => setTimeout(res, 150)); // give any errant signal a moment
  expect(existsSync(pidfileB)).toBe(true);
  expect(isAlive(drainB.pid)).toBe(true);

  drainB.kill('SIGTERM');
  await new Promise((res) => drainB.on('close', res));
  await cupA.close();
  await cupB.close();
});
