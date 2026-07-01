import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  cupDiscoveryPath,
  stopByPid,
} from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';
import { spawnScript } from './_spawn.mjs';

const noSleep = () => Promise.resolve();

describe('stopByPid (pure escalation)', () => {
  test('a pid that is already dead is a no-op', async () => {
    const kills = [];
    const r = await stopByPid({
      pid: 1,
      isAlive: () => false,
      kill: (p, s) => kills.push([p, s]),
      sleep: noSleep,
    });
    expect(r).toEqual({ signaled: false, escalated: false, confirmed: true });
    expect(kills).toEqual([]);
  });

  test('SIGTERM suffices when the process exits within the grace window', async () => {
    const alive = [true, false]; // guard sees it alive; first poll sees it gone
    const kills = [];
    const r = await stopByPid({
      pid: 42,
      isAlive: () => alive.shift() ?? false,
      kill: (p, s) => kills.push([p, s]),
      sleep: noSleep,
    });
    expect(r).toEqual({ signaled: true, escalated: false, confirmed: true });
    expect(kills).toEqual([[42, 'SIGTERM']]);
  });

  test('escalates to SIGKILL and reports unconfirmed when the process survives even that', async () => {
    const kills = [];
    const r = await stopByPid({
      pid: 42,
      isAlive: () => true, // never dies — survives SIGTERM AND SIGKILL (D-state)
      kill: (p, s) => kills.push([p, s]),
      sleep: noSleep,
      attempts: 3,
    });
    // confirmed:false — the post-SIGKILL isAlive still sees it, so the caller must
    // NOT clear cup.json (snags-3).
    expect(r).toEqual({ signaled: true, escalated: true, confirmed: false });
    expect(kills).toEqual([
      [42, 'SIGTERM'],
      [42, 'SIGKILL'],
    ]);
  });

  test('confirms death when SIGKILL lands (post-SIGKILL isAlive turns false)', async () => {
    // Alive for: guard, 3 grace polls, the pre-SIGKILL check (→ SIGKILL fires),
    // then DEAD on the post-SIGKILL check → escalated + confirmed.
    const alive = [true, true, true, true, true, false];
    const r = await stopByPid({
      pid: 42,
      isAlive: () => alive.shift() ?? false,
      kill: () => {},
      sleep: noSleep,
      attempts: 3,
    });
    expect(r).toEqual({ signaled: true, escalated: true, confirmed: true });
  });
});

describe('cup-stop.mjs (integration)', () => {
  let dir;
  let child;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lb-stop-'));
  });
  afterEach(() => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (fn()) return true;
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  test('stops the recorded cup process and clears the discovery file', async () => {
    // The `--cup` arg makes the process look like a cup to cup-stop's identity gate.
    child = spawn('node', ['-e', 'setInterval(() => {}, 1e9)', '--cup'], { stdio: 'ignore' });
    await waitFor(() => isAlive(child.pid));
    writeFileSync(
      cupDiscoveryPath(dir),
      JSON.stringify({ port: 5710, pid: child.pid, startedAt: '2026-06-30T00:00:00.000Z' })
    );

    const r = await spawnScript('cup-stop.mjs', [], { SLICC_DIR: dir });
    expect(r.code).toBe(0);
    expect(await waitFor(() => !isAlive(child.pid))).toBe(true);
    expect(existsSync(cupDiscoveryPath(dir))).toBe(false);
  });

  test('refuses to signal a recycled pid that is NOT a cup, and clears the stale record', async () => {
    // A live process WITHOUT `--cup` stands in for a pid the OS recycled onto an
    // unrelated same-user process after the cup exited (security-1).
    child = spawn('node', ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    await waitFor(() => isAlive(child.pid));
    writeFileSync(
      cupDiscoveryPath(dir),
      JSON.stringify({ port: 5710, pid: child.pid, startedAt: '2026-06-30T00:00:00.000Z' })
    );

    const r = await spawnScript('cup-stop.mjs', [], { SLICC_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('pid reused');
    // The innocent process is left running; the stale record is cleared.
    expect(isAlive(child.pid)).toBe(true);
    expect(existsSync(cupDiscoveryPath(dir))).toBe(false);
  });

  test('reports cleanly when no cup is running (no cup.json)', async () => {
    const r = await spawnScript('cup-stop.mjs', [], { SLICC_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('no cup');
  });
});
