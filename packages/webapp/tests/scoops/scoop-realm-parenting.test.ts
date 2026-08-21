/**
 * Regression for PR #1166 (P1) — a scoop/cone agent bash-tool realm-backed
 * long-runner must be terminated when the scoop turn is stopped/dropped.
 *
 * `ScoopContext.initShellAndSkills` now threads the scoop's process context
 * (`processManager` + `processOwner` + `getCurrentShellPid`) into the
 * `AlmostBashShellHeadless` it builds for the agent's `bash` tool. Without it,
 * `buildJshProcessConfig()` returns `undefined` and a hanging `node`/`.jsh`/
 * `python` registers at `ppid:1`; the scoop's stop/dispose/drop path signals
 * the `kind:'scoop-turn'` pid, whose ppid fan-out only reaches true
 * descendants — so the orphaned realm child survives and keeps running.
 *
 * This drives the REAL `ProcessManager` + `AlmostBashShellHeadless` (in-process realm)
 * so the parenting + fan-out is exercised end-to-end.
 */

import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import type { BrowserAPI } from '../../src/cdp/index.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

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
    const shell = new AlmostBashShellHeadless({
      fs,
      cwd: '/scoops/test/workspace',
      browserAPI: {} as BrowserAPI,
      processManager: pm,
      processOwner: { kind: 'scoop', scoopJid: 'scoop_test' },
      getCurrentShellPid: () => turn.pid,
    });
    // A caller with no per-run job pid (any `executeCommand` without one) must
    // still fall back to `getCurrentShellPid` (the scoop-turn pid).
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

  it("parents each concurrent run's realm child to ITS OWN job pid", async () => {
    // The bash tool detaches slow commands, so two runs share one shell. The
    // per-run parentage must follow the run, not whichever `executeCommand`
    // touched `activeShellPid` last — otherwise `kill <pid>` on one job reaps
    // the other job's realm worker.
    const fs = await makeFs();
    const pm = new ProcessManager();
    const turn = spawnTurn(pm);
    const shell = new AlmostBashShellHeadless({
      fs,
      cwd: '/scoops/test/workspace',
      browserAPI: {} as BrowserAPI,
      processManager: pm,
      processOwner: { kind: 'scoop', scoopJid: 'scoop_test' },
      getCurrentShellPid: () => turn.pid,
    });
    const spawnJob = (command: string) =>
      pm.spawn({
        kind: 'shell',
        argv: ['bash', '-c', command],
        cwd: '/scoops/test/workspace',
        owner: { kind: 'scoop', scoopJid: 'scoop_test' },
        ppid: turn.pid,
      });

    // Job A spawns its realm child LATE (after job B has taken over as the
    // most-recent run) — the exact shape that mis-parented before.
    const slowThenRealm = `sleep 0.3 && ${YIELDING_NODE}`;
    const jobA = spawnJob(slowThenRealm);
    const jobB = spawnJob('sleep 5');
    const abortA = new AbortController();
    const abortB = new AbortController();
    const execA = shell.executeCommand(slowThenRealm, abortA.signal, jobA.pid);
    const execB = shell.executeCommand('sleep 5', abortB.signal, jobB.pid);

    const realmPid = await waitForRealmPid(pm);
    expect(pm.get(realmPid)!.ppid, "realm child must parent to its own run's job pid").toBe(
      jobA.pid
    );

    // And the consequence that matters: killing job A reaches that realm child
    // while job B is untouched.
    pm.signal(jobA.pid, 'SIGKILL');
    expect(pm.get(realmPid)?.terminatedBy).toBe('SIGKILL');
    expect(pm.get(jobB.pid)?.status).toBe('running');

    abortA.abort();
    abortB.abort();
    await Promise.allSettled([execA, execB]);
    shell.dispose();
  }, 10_000);

  // Codex review on PR #2210 (P2): the `node`/`python` commands were signal-aware
  // but the two `.jsh` dispatch paths still called `buildJshProcessConfig()` bare,
  // so a discovered `.jsh` fell back to the mutable `activeShellPid` and a
  // concurrent run could steal its parentage.
  // The per-run pid rides the run's own env (just-bash >= 3.2 no longer hands a
  // command the signal its exec started with, so the old signal-keyed WeakMap
  // never hit). That tag must not outlive its run: it is stripped from the env
  // written back onto the shell, or a later untagged run would inherit a dead
  // pid and parent its realm child to an already-reaped job.
  it("does not leak a finished run's pid into a later untagged run", async () => {
    const fs = await makeFs();
    const pm = new ProcessManager();
    const turn = spawnTurn(pm);
    const shell = new AlmostBashShellHeadless({
      fs,
      cwd: '/scoops/test/workspace',
      browserAPI: {} as BrowserAPI,
      processManager: pm,
      processOwner: { kind: 'scoop', scoopJid: 'scoop_test' },
      getCurrentShellPid: () => turn.pid,
    });
    const job = pm.spawn({
      kind: 'shell',
      argv: ['bash', '-c', 'true'],
      cwd: '/scoops/test/workspace',
      owner: { kind: 'scoop', scoopJid: 'scoop_test' },
      ppid: turn.pid,
    });
    // A tagged run that finishes and is reaped.
    await shell.executeCommand('true', undefined, job.pid);
    pm.signal(job.pid, 'SIGKILL');

    // The tag is internal — it must not be observable in a later run's env.
    const envOut = await shell.executeCommand('env');
    expect(envOut.stdout).not.toContain('__SLICC_RUN_PID');

    // And a later run with no pid of its own falls back to the scoop turn.
    const abort = new AbortController();
    const execPromise = shell.executeCommand(YIELDING_NODE, abort.signal);
    const realmPid = await waitForRealmPid(pm);
    expect(pm.get(realmPid)!.ppid, 'stale run pid inherited by a later run').toBe(turn.pid);

    abort.abort();
    await execPromise.catch(() => undefined);
    shell.dispose();
  }, 10_000);

  it("parents a discovered .jsh realm child to ITS OWN run's job pid", async () => {
    const fs = await makeFs();
    await fs.mkdir('/workspace/skills/bgjob/scripts', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/bgjob/scripts/hangjsh.jsh',
      'await new Promise((r) => setTimeout(r, 60000));'
    );
    const pm = new ProcessManager();
    const turn = spawnTurn(pm);
    const shell = new AlmostBashShellHeadless({
      fs,
      cwd: '/workspace',
      browserAPI: {} as BrowserAPI,
      processManager: pm,
      processOwner: { kind: 'scoop', scoopJid: 'scoop_test' },
      getCurrentShellPid: () => turn.pid,
    });
    const spawnJob = (command: string) =>
      pm.spawn({
        kind: 'shell',
        argv: ['bash', '-c', command],
        cwd: '/workspace',
        owner: { kind: 'scoop', scoopJid: 'scoop_test' },
        ppid: turn.pid,
      });

    // Same late-spawn shape as the `node` case: job A reaches its `.jsh` only
    // after job B has become the most recent run on this shell.
    const jshCommand = 'sleep 0.3 && hangjsh';
    const jobA = spawnJob(jshCommand);
    const jobB = spawnJob('sleep 5');
    const abortA = new AbortController();
    const abortB = new AbortController();
    const execA = shell.executeCommand(jshCommand, abortA.signal, jobA.pid);
    const execB = shell.executeCommand('sleep 5', abortB.signal, jobB.pid);

    const realmPid = await waitForRealmPid(pm);
    expect(pm.get(realmPid)!.ppid, ".jsh realm child must parent to its own run's job").toBe(
      jobA.pid
    );

    pm.signal(jobA.pid, 'SIGKILL');
    expect(pm.get(realmPid)?.terminatedBy).toBe('SIGKILL');
    expect(pm.get(jobB.pid)?.status).toBe('running');

    abortA.abort();
    abortB.abort();
    await Promise.allSettled([execA, execB]);
    shell.dispose();
  }, 10_000);

  it('control: without the turn-pid wiring the realm orphans at ppid:1 and survives', async () => {
    const fs = await makeFs();
    const pm = new ProcessManager();
    const turn = spawnTurn(pm);
    // Same manager + owner, but NO `getCurrentShellPid` — mirrors the pre-fix
    // construction where `buildJshProcessConfig` has no parent pid to attach.
    const shell = new AlmostBashShellHeadless({
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
