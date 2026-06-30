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
    expect(r).toEqual({ signaled: false, escalated: false });
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
    expect(r).toEqual({ signaled: true, escalated: false });
    expect(kills).toEqual([[42, 'SIGTERM']]);
  });

  test('escalates to SIGKILL when the process survives the grace window', async () => {
    const kills = [];
    const r = await stopByPid({
      pid: 42,
      isAlive: () => true, // never dies on its own
      kill: (p, s) => kills.push([p, s]),
      sleep: noSleep,
      attempts: 3,
    });
    expect(r).toEqual({ signaled: true, escalated: true });
    expect(kills).toEqual([
      [42, 'SIGTERM'],
      [42, 'SIGKILL'],
    ]);
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
    child = spawn('node', ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
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

  test('reports cleanly when no cup is running (no cup.json)', async () => {
    const r = await spawnScript('cup-stop.mjs', [], { SLICC_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('no cup');
  });
});
