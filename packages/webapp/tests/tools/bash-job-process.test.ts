/**
 * The bash tool over a REAL `ProcessManager`, wired the way `ScoopContext` wires
 * it. The fakes in `bash-tool.test.ts` prove the tool calls the handle; these
 * prove the handle's kill actually reaches a realm-backed descendant, which is
 * the whole reason a bash run is registered as a pid.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import type { AlmostBashShell } from '../../src/shell/index.js';
import { createBashTool } from '../../src/tools/bash-tool.js';
import type { BashJobHost } from '../../src/tools/types.js';

/** A shell whose command hangs until the test settles it, recording the pid it got. */
function pendingShell() {
  const shellPids: (number | undefined)[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let settle!: (r: { stdout: string; stderr: string; exitCode: number }) => void;
  const shell = {
    executeCommand: (_cmd: string, signal?: AbortSignal, shellPid?: number) => {
      signals.push(signal);
      shellPids.push(shellPid);
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((res) => {
        settle = res;
      });
    },
  };
  return {
    shell: shell as unknown as AlmostBashShell,
    shellPids,
    signals,
    settle: (r: { stdout: string; stderr: string; exitCode: number }) => settle(r),
  };
}

/**
 * Mirror of `ScoopContext.spawnBashJob`: a `kind:'shell'` record parented to the
 * turn pid, whose `kill` is a SIGKILL through the manager (so the ppid fan-out
 * applies) rather than a bare `abort()`.
 */
function jobHostOver(pm: ProcessManager, turnPid: number | undefined): BashJobHost {
  return {
    spawn: (command) => {
      const proc = pm.spawn({
        kind: 'shell',
        argv: ['bash', '-c', command],
        cwd: '/workspace',
        owner: { kind: 'cone' },
        ppid: turnPid,
      });
      return {
        pid: proc.pid,
        signal: proc.abort.signal,
        kill: () => {
          pm.signal(proc.pid, 'SIGKILL');
        },
        exit: (code) => pm.exit(proc.pid, code),
      };
    },
  };
}

describe('bash job process over a real ProcessManager', () => {
  let fs: VirtualFS;
  let pm: ProcessManager;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-bash-pm-${dbCounter++}`, wipe: true });
    pm = new ProcessManager();
  });

  it('lists a detached job in ps and reaps it when the command finishes', async () => {
    const { shell, settle } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: jobHostOver(pm, undefined) });

    await bash.execute({ command: 'long-build', background_after: 0 });

    const live = pm.list().filter((p) => p.kind === 'shell' && p.status === 'running');
    expect(live).toHaveLength(1);
    expect(live[0].argv).toEqual(['bash', '-c', 'long-build']);

    settle({ stdout: 'ok', stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(pm.get(live[0].pid)?.status).toBe('exited'));
    expect(pm.get(live[0].pid)?.exitCode).toBe(0);
  });

  it('SIGKILL at timeout fans out to a realm-backed descendant of the job', async () => {
    const { shell, shellPids } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: jobHostOver(pm, undefined) });

    // `background_after` large, `timeout` small: the tool must kill, not detach.
    const pending = bash.execute({ command: 'node -e "while(true){}"', timeout: 0.02 });

    // What the shell does with the pid it was handed: a realm child parents to it.
    await vi.waitFor(() => expect(shellPids[0]).toBeDefined());
    const jobPid = shellPids[0] as number;
    const realm = pm.spawn({
      kind: 'jsh',
      argv: ['node', '-e', 'while(true){}'],
      cwd: '/workspace',
      owner: { kind: 'cone' },
      ppid: jobPid,
    });

    const result = await pending;
    expect(result.isError).toBe(true);
    // The realm child is what a `worker.terminate()` hangs off: the realm runner
    // subscribes to exactly this signal delivery.
    expect(realm.terminatedBy).toBe('SIGKILL');
    expect(realm.abort.signal.aborted).toBe(true);
    expect(pm.get(jobPid)?.terminatedBy).toBe('SIGKILL');
  });

  it('kill <pid> on a detached job aborts the run and reaps its realm child', async () => {
    const { shell, signals, shellPids } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: jobHostOver(pm, undefined) });

    await bash.execute({ command: 'watcher', background_after: 0 });
    const jobPid = shellPids[0] as number;
    const realm = pm.spawn({
      kind: 'jsh',
      argv: ['node', 'watch.js'],
      cwd: '/workspace',
      owner: { kind: 'cone' },
      ppid: jobPid,
    });

    // A user (or the agent) typing `kill -9 <pid>` in any shell.
    expect(pm.signal(jobPid, 'SIGKILL')).toBe(true);

    expect(signals[0]?.aborted).toBe(true);
    expect(realm.terminatedBy).toBe('SIGKILL');
  });

  it('survives a normal turn end but dies with an explicit turn cancel', async () => {
    const turn = pm.spawn({
      kind: 'scoop-turn',
      argv: ['prompt', 'build it'],
      cwd: '/workspace',
      owner: { kind: 'cone' },
    });
    const { shell, signals, shellPids } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: jobHostOver(pm, turn.pid) });

    await bash.execute({ command: 'long-build', background_after: 0 });
    const jobPid = shellPids[0] as number;

    // Normal turn end: `exit` does NOT cascade, so the detached job lives on to
    // deliver its lick.
    pm.exit(turn.pid, 0);
    expect(pm.get(jobPid)?.status).toBe('running');
    expect(signals[0]?.aborted).toBe(false);

    // Explicit cancel of a LIVE turn is what fans out; re-run that shape.
    const turn2 = pm.spawn({
      kind: 'scoop-turn',
      argv: ['prompt', 'build it'],
      cwd: '/workspace',
      owner: { kind: 'cone' },
    });
    const second = pendingShell();
    const bash2 = createBashTool(second.shell, fs, '/tmp', { jobHost: jobHostOver(pm, turn2.pid) });
    await bash2.execute({ command: 'long-build', background_after: 0 });

    pm.signal(turn2.pid, 'SIGINT');
    expect(second.signals[0]?.aborted).toBe(true);
    expect(pm.get(second.shellPids[0] as number)?.terminatedBy).toBe('SIGINT');
  });
});
