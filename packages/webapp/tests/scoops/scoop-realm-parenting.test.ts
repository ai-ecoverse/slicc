/**
 * Regression for PR #1166 (P1) — a scoop/cone agent bash-tool realm-backed
 * long-runner must be terminated when the scoop turn is stopped/dropped.
 *
 * `ScoopContext.initShellAndSkills` now threads the scoop's process context
 * (`processManager` + `processOwner` + `getCurrentShellPid`) into the
 * `AlmostBashShell` it builds for the agent's `bash` tool. Without it,
 * `buildJshProcessConfig()` returns `undefined` and a hanging `node`/`.jsh`/
 * `python` registers at `ppid:1`; the scoop's stop/dispose/drop path signals
 * the `kind:'scoop-turn'` pid, whose ppid fan-out only reaches true
 * descendants — so the orphaned realm child survives and keeps running.
 *
 * This drives the REAL `ProcessManager` + `AlmostBashShell` (in-process realm)
 * so the parenting + fan-out is exercised end-to-end.
 */

import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import type { BrowserAPI } from '../../src/cdp/index.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { AlmostBashShell } from '../../src/shell/index.js';

/** A realm-backed foreground job that yields (so the in-process realm settles). */
const YIELDING_NODE = "node -e 'await new Promise(r=>setTimeout(r,60000))'";
const BUDGET_MS = 1500;

function tick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRealmPid(pm: ProcessManager): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const realm = pm.list().find((p) => p.kind === 'jsh' && p.status === 'running');
    if (realm) return realm.pid;
    await tick(10);
  }
  throw new Error('realm process never registered');
}

async function raceExec(execPromise: Promise<{ exitCode: number }>) {
  return Promise.race([
    execPromise.then((r) => ({ timedOut: false as const, exitCode: r.exitCode })),
    tick(BUDGET_MS).then(() => ({ timedOut: true as const, exitCode: -1 })),
  ]);
}

async function makeFs(): Promise<VirtualFS> {
  return VirtualFS.create({
    dbName: `pr-1166-${Math.random().toString(36).slice(2)}`,
    wipe: true,
  });
}

/** Spawn the `kind:'scoop-turn'` process `registerTurnProcess` creates. */
function spawnTurn(pm: ProcessManager) {
  return pm.spawn({
    kind: 'scoop-turn',
    argv: ['prompt', 'do work'],
    cwd: '/scoops/test/workspace',
    owner: { kind: 'scoop', scoopJid: 'scoop_test' },
  });
}

describe('PR #1166 (P1) — agent bash-tool realm children parent under the scoop turn', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__slicc_pm;
  });

  it('parents the realm child to the scoop-turn pid so Stop/drop terminates it', async () => {
    const fs = await makeFs();
    const pm = new ProcessManager();
    const turn = spawnTurn(pm);
    const shell = new AlmostBashShell({
      fs,
      cwd: '/scoops/test/workspace',
      browserAPI: {} as BrowserAPI,
      processManager: pm,
      processOwner: { kind: 'scoop', scoopJid: 'scoop_test' },
      getCurrentShellPid: () => turn.pid,
    });
    // The agent's `bash` tool calls executeCommand WITHOUT a shell pid, so the
    // realm child must fall back to `getCurrentShellPid` (the scoop-turn pid).
    const execPromise = shell.executeCommand(YIELDING_NODE);
    const realmPid = await waitForRealmPid(pm);
    const realm = pm.get(realmPid)!;
    expect(realm.ppid, 'realm child must parent to the scoop-turn pid, not ppid:1').toBe(turn.pid);

    // dispose() signals the turn pid with SIGTERM; the fan-out must reach the realm.
    pm.signal(turn.pid, 'SIGTERM');
    const outcome = await raceExec(execPromise);
    const realmStatus = pm.get(realmPid)?.status;
    shell.dispose();
    expect(outcome.timedOut, 'realm child survived the scoop-turn signal').toBe(false);
    expect(realmStatus, 'realm child still running after scoop-turn SIGTERM').not.toBe('running');
  }, 10_000);

  it('control: without the turn-pid wiring the realm orphans at ppid:1 and survives', async () => {
    const fs = await makeFs();
    const pm = new ProcessManager();
    const turn = spawnTurn(pm);
    // Same manager + owner, but NO `getCurrentShellPid` — mirrors the pre-fix
    // construction where `buildJshProcessConfig` has no parent pid to attach.
    const shell = new AlmostBashShell({
      fs,
      cwd: '/scoops/test/workspace',
      browserAPI: {} as BrowserAPI,
      processManager: pm,
      processOwner: { kind: 'scoop', scoopJid: 'scoop_test' },
    });
    const execPromise = shell.executeCommand(YIELDING_NODE);
    const realmPid = await waitForRealmPid(pm);
    expect(pm.get(realmPid)!.ppid, 'unparented realm child orphans at ppid:1').toBe(1);

    pm.signal(turn.pid, 'SIGTERM');
    const outcome = await raceExec(execPromise);
    expect(outcome.timedOut, 'orphaned realm child is NOT reached by the turn-pid fan-out').toBe(
      true
    );

    // Cleanup: hard-kill the surviving realm so the 60s timer doesn't leak.
    pm.signal(realmPid, 'SIGKILL');
    await execPromise;
    shell.dispose();
  }, 10_000);
});
