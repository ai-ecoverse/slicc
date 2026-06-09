import { describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import {
  createWorkflowRunManager,
  evictOldRuns,
  publishWorkflowRunManager,
  WORKFLOW_MANAGER_GLOBAL_KEY,
  type WorkflowRunState,
} from '../../src/scoops/workflow-run-manager.js';
import { createWorkflowCommand } from '../../src/shell/supplemental-commands/workflow-command.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeDeps(overrides: Partial<Parameters<typeof createWorkflowRunManager>[0]> = {}) {
  return {
    sharedFs: { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) } as any,
    getConeJid: () => 'cone_1',
    fireLick: vi.fn(),
    processManager: { on: vi.fn(() => () => {}) } as any,
    // runRealm is the injectable launch (real impl calls executeJsCode); tests stub it.
    runRealm: vi.fn(async () => ({
      stdout: `WF_RESULT_x${JSON.stringify({ ok: true })}`,
      stderr: '',
      exitCode: 0,
    })),
    makeRunId: () => 'run1',
    splitResult: (_stdout: string) => ({ result: { ok: true }, log: '', hadResult: true }),
    ...overrides,
  };
}

// NOTE: `sentinel` is a required field on WorkflowStartOptions — every `mgr.start({...})`
// call below passes `sentinel: 'WF_RESULT_x'` (shown on the first call; add it to each).

describe('WorkflowRunManager', () => {
  it('start() returns a runId without awaiting completion; status running → done; observeRun fires', async () => {
    const realmDone = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    const deps = makeDeps({ runRealm: vi.fn(() => realmDone.promise) });
    const mgr = createWorkflowRunManager(deps as any);
    const states: string[] = [];

    const { runId } = await mgr.start({
      code: 'CODE',
      source: 'SRC',
      name: 'demo',
      filename: 'wf.js',
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: { cwd: '/', env: new Map(), stdin: '', exec: vi.fn() } as any,
    });
    expect(runId).toBe('run1');
    mgr.observeRun(runId, (s: WorkflowRunState) => states.push(s.status));
    expect(mgr.getRun(runId)!.status).toBe('running'); // launched, not awaited

    realmDone.resolve({
      stdout: `WF_RESULT_x${JSON.stringify({ ok: true })}`,
      stderr: '',
      exitCode: 0,
    });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
    expect(states).toContain('done');
    expect(mgr.listRuns().map((r) => r.id)).toContain('run1');
  });

  it('terminal-origin does NOT fire a lick; cone-origin does', async () => {
    const fireLick = vi.fn();
    const mgr = createWorkflowRunManager(makeDeps({ fireLick }) as any);
    await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(mgr.listRuns()[0].status).toBe('done'));
    expect(fireLick).not.toHaveBeenCalled();

    const fireLick2 = vi.fn();
    const mgr2 = createWorkflowRunManager(makeDeps({ fireLick: fireLick2 }) as any);
    await mgr2.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: 'cone_1',
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(fireLick2).toHaveBeenCalledTimes(1));
    expect(fireLick2.mock.calls[0][0].type).toBe('workflow');
    expect(fireLick2.mock.calls[0][0].resultPath).toContain('/shared/workflow-runs/');
  });

  it('non-zero exit → status error + error notification', async () => {
    const fireLick = vi.fn();
    const mgr = createWorkflowRunManager(
      makeDeps({
        fireLick,
        runRealm: vi.fn(async () => ({ stdout: '', stderr: 'boom', exitCode: 1 })),
      }) as any
    );
    await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: 'cone_1',
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(mgr.listRuns()[0].status).toBe('error'));
    expect(mgr.listRuns()[0].error).toContain('boom');
    expect(fireLick).toHaveBeenCalledTimes(1);
  });

  it('exec-tap: agent argv bumps agentsStarted/Done; __wf_progress updates phase/logs; others pass through', async () => {
    const realExecCalls: string[][] = [];
    const baseCtx = {
      cwd: '/',
      env: new Map<string, string>(),
      stdin: '',
      exec: Object.assign(
        async (cmd: string, opts?: { args?: string[] }) => {
          realExecCalls.push([cmd, ...(opts?.args ?? [])]);
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        },
        { spawn: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) }
      ),
    } as any;
    // runRealm drives the tapped ctx the way the realm would, then resolves.
    const deps = makeDeps({
      runRealm: vi.fn(async (_code: string, _argv: string[], ctx: any) => {
        await ctx.exec('__wf_progress', { args: ['phase', 'Scan'] });
        await ctx.exec('__wf_progress', { args: ['log', 'hello'] });
        await ctx.exec('agent', { args: ['--read-only', '/workspace/', '/s', '*', 'do it'] });
        await ctx.exec('ls', { args: ['/workspace'] });
        return { stdout: `WF_RESULT_x${JSON.stringify({ ok: true })}`, stderr: '', exitCode: 0 };
      }),
    });
    const mgr = createWorkflowRunManager(deps as any);
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: baseCtx,
    });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
    const s = mgr.getRun(runId)!;
    expect(s.currentPhase).toBe('Scan');
    expect(s.logs).toEqual(['Scan', 'hello']); // phase title + log message, in order; currentPhase tracked separately
    expect(s.agentsStarted).toBe(1);
    expect(s.agentsDone).toBe(1);
    // __wf_progress was intercepted (not passed through); agent + ls were:
    expect(realExecCalls.find((c) => c[0] === '__wf_progress')).toBeUndefined();
    expect(realExecCalls.find((c) => c[0] === 'agent')).toBeDefined();
    expect(realExecCalls.find((c) => c[0] === 'ls')).toBeDefined();
  });

  it('captures the realm pid via pm.on(spawn)', async () => {
    let spawnHandler: ((p: any) => void) | undefined;
    const pm = {
      on: vi.fn((_e: string, fn: any) => {
        spawnHandler = fn;
        return () => {};
      }),
    };
    const realmDone = deferred<any>();
    const deps = makeDeps({ processManager: pm as any, runRealm: vi.fn(() => realmDone.promise) });
    const mgr = createWorkflowRunManager(deps as any);
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: { exec: vi.fn() } as any,
    });
    // Real realm-JS processes are kind:'jsh' (runInRealm default). The production filter
    // matches the unique runId ANYWHERE in argv (`argv.includes(runId)`), NOT kind, so kind
    // here is just realistic fixture data — must match reality so the test isn't misleading.
    // makeRunId returns 'run1' here, and argv carries it.
    // A spawn whose argv does NOT include the runId must be ignored (no false pid capture).
    spawnHandler?.({ pid: 9999, kind: 'jsh', argv: ['workflow', 'f', 'someOtherRun'] });
    expect(mgr.getRun(runId)!.pid).toBeNull();
    spawnHandler?.({ pid: 4242, kind: 'jsh', argv: ['workflow', 'f', 'run1'] });
    expect(mgr.getRun(runId)!.pid).toBe(4242);
    realmDone.resolve({ stdout: `WF_RESULT_x${JSON.stringify({})}`, stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
  });

  it('pid capture is one-shot: self-unsubscribes after the first matching spawn', async () => {
    const offSpawn = vi.fn();
    let spawnHandler: ((p: any) => void) | undefined;
    const pm = {
      on: vi.fn((_e: string, fn: any) => {
        spawnHandler = fn;
        return offSpawn;
      }),
    };
    const realmDone = deferred<any>();
    const deps = makeDeps({ processManager: pm as any, runRealm: vi.fn(() => realmDone.promise) });
    const mgr = createWorkflowRunManager(deps as any);
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: { exec: vi.fn() } as any,
    });
    // First matching spawn captures the pid AND unsubscribes the listener.
    spawnHandler?.({ pid: 4242, kind: 'jsh', argv: ['workflow', 'f', 'run1'] });
    expect(mgr.getRun(runId)!.pid).toBe(4242);
    expect(offSpawn).toHaveBeenCalledTimes(1);
    // A later spawn re-using the same runId must NOT overwrite the captured pid
    // (state.pid !== null also guards, but the listener is already detached).
    spawnHandler?.({ pid: 5555, kind: 'jsh', argv: ['workflow', 'f', 'run1'] });
    expect(mgr.getRun(runId)!.pid).toBe(4242);
    realmDone.resolve({ stdout: `WF_RESULT_x${JSON.stringify({})}`, stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
  });

  it('concurrent same-file runs capture DISTINCT pids (no aliasing) — matched by runId anywhere in argv', async () => {
    // Every `start()` registers its own spawn listener. Capture them all so we can
    // replay each run's spawn event to every listener — exactly what the real PM does
    // (it broadcasts each spawn to all subscribers). Each listener must only claim the
    // pid whose argv includes ITS runId, then self-unsubscribe.
    const handlers: ((p: any) => void)[] = [];
    const pm = {
      on: vi.fn((_e: string, fn: any) => {
        handlers.push(fn);
        return () => {
          const i = handlers.indexOf(fn);
          if (i >= 0) handlers.splice(i, 1);
        };
      }),
    };
    // Distinct run ids from a counter — same filename for both runs.
    let n = 0;
    const realm1 = deferred<any>();
    const realm2 = deferred<any>();
    const realms = [realm1.promise, realm2.promise];
    let r = 0;
    const deps = makeDeps({
      processManager: pm as any,
      makeRunId: () => `run${++n}`,
      runRealm: vi.fn(() => realms[r++]),
    });
    const mgr = createWorkflowRunManager(deps as any);

    const a = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f', // SAME file
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: { exec: vi.fn() } as any,
    });
    const b = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f', // SAME file — pre-fix this aliased both runs to one pid
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: { exec: vi.fn() } as any,
    });
    expect(a.runId).toBe('run1');
    expect(b.runId).toBe('run2');

    // Broadcast each run's spawn (identical argv[0..1], unique runId in argv) to ALL listeners.
    const broadcast = (p: any) => {
      for (const h of handlers) h(p);
    };
    broadcast({ pid: 100, kind: 'jsh', argv: ['workflow', 'f', 'run1'] });
    broadcast({ pid: 200, kind: 'jsh', argv: ['workflow', 'f', 'run2'] });

    // Each run captured its OWN pid — no aliasing.
    expect(mgr.getRun('run1')!.pid).toBe(100);
    expect(mgr.getRun('run2')!.pid).toBe(200);

    realm1.resolve({ stdout: `WF_RESULT_x${JSON.stringify({})}`, stderr: '', exitCode: 0 });
    realm2.resolve({ stdout: `WF_RESULT_x${JSON.stringify({})}`, stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(mgr.getRun('run1')!.status).toBe('done'));
    await vi.waitFor(() => expect(mgr.getRun('run2')!.status).toBe('done'));
  });

  it('exit 137 (SIGKILL) → status killed (not error)', async () => {
    const fireLick = vi.fn();
    const sharedFs = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
    const mgr = createWorkflowRunManager(
      makeDeps({
        fireLick,
        sharedFs: sharedFs as any,
        runRealm: vi.fn(async () => ({
          stdout: '',
          stderr: 'killed (SIGKILL)',
          exitCode: 137,
        })),
      }) as any
    );
    await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: 'cone_1',
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(mgr.listRuns()[0].status).toBe('killed'));
    expect(mgr.listRuns()[0].status).toBe('killed');
    expect(sharedFs.writeFile).toHaveBeenCalledTimes(1);
    expect(fireLick).toHaveBeenCalledTimes(1);
  });

  it('complete() is idempotent: a second settlement after a terminal status is a no-op (no double write/lick)', async () => {
    // `complete()` isn't on the public surface, so we exercise its re-entrancy guard through
    // the launch lifecycle. The internal chain is `runRealm(...).then(finish)…`; a buggy/racy
    // double-settle (e.g. an explicit stop racing the realm's own exit) would drive `finish`
    // → `complete` twice. We reproduce that with a thenable whose `then(onFulfilled)` invokes
    // its fulfillment handler TWICE — the first reaches `complete('done')`, the second must be
    // short-circuited by the guard so writeFile + fireLick stay at exactly 1.
    type ExecResultLikeShim = { stdout: string; stderr: string; exitCode: number };
    const fireLick = vi.fn();
    const sharedFs = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
    const out: ExecResultLikeShim = {
      stdout: `WF_RESULT_x${JSON.stringify({ ok: true })}`,
      stderr: '',
      exitCode: 0,
    };
    const doubleSettleRealm = {
      // `finish`/`complete` are async; await the FIRST completion fully (so status is
      // already 'done') before driving the racy SECOND one — that is precisely the
      // "already terminal" window the guard short-circuits.
      async then(onFulfilled: (v: ExecResultLikeShim) => unknown) {
        await onFulfilled(out); // first settlement → finish → complete('done') (awaited)
        await onFulfilled(out); // racy SECOND settlement → complete() now sees terminal → no-op
      },
    };
    const mgr = createWorkflowRunManager(
      makeDeps({
        fireLick,
        sharedFs: sharedFs as any,
        runRealm: vi.fn(() => doubleSettleRealm as unknown as Promise<ExecResultLikeShim>),
      }) as any
    );
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: 'cone_1',
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
    // Both completion attempts have run; the guard kept the side effects single-shot.
    expect(mgr.getRun(runId)!.status).toBe('done');
    expect(sharedFs.writeFile).toHaveBeenCalledTimes(1); // no double write
    expect(fireLick).toHaveBeenCalledTimes(1); // no double lick
  });

  it('result-file write failure → run ends error, error mentions the failure, resultPath stays null, cone lick fires once', async () => {
    const fireLick = vi.fn();
    const sharedFs = {
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {
        throw new Error('EIO');
      }),
    };
    const mgr = createWorkflowRunManager(makeDeps({ fireLick, sharedFs: sharedFs as any }) as any);
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: 'cone_1',
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('error'));
    const s = mgr.getRun(runId)!;
    // A `done` realm result was downgraded to `error` because the durable result
    // file (the cone's only handle on a non-preview result) could not be written.
    expect(s.status).toBe('error');
    expect(s.error).toContain('result file write failed');
    expect(s.error).toContain('EIO');
    expect(s.resultPath).toBeNull(); // resultPath assignment is skipped on write failure
    // The cone is still notified exactly once (so it isn't left hanging on a run
    // that never reports), now with the honest error status.
    expect(fireLick).toHaveBeenCalledTimes(1);
  });

  it('runRealm rejection → fail(): status error, error mentions the crash, file written, cone lick once', async () => {
    const fireLick = vi.fn();
    const sharedFs = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
    const mgr = createWorkflowRunManager(
      makeDeps({
        fireLick,
        sharedFs: sharedFs as any,
        runRealm: vi.fn(async () => {
          throw new Error('realm crashed');
        }),
      }) as any
    );
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: 'cone_1',
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('error'));
    expect(mgr.getRun(runId)!.error).toContain('realm crashed');
    // spec §8: the run file is written for failures too (so the cone can recover the error).
    expect(sharedFs.writeFile).toHaveBeenCalledTimes(1);
    expect(fireLick).toHaveBeenCalledTimes(1);
  });

  it('exit 0 but no result → status error with "script produced no result"', async () => {
    const mgr = createWorkflowRunManager(
      makeDeps({
        runRealm: vi.fn(async () => ({ stdout: 'logs only', stderr: '', exitCode: 0 })),
        splitResult: () => ({ result: null, log: '', hadResult: false }),
      }) as any
    );
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('error'));
    expect(mgr.getRun(runId)!.error).toBe('script produced no result');
  });

  it("'scoop' origin (parentJid is not the cone jid) does NOT fire a lick", async () => {
    const fireLick = vi.fn();
    const mgr = createWorkflowRunManager(makeDeps({ fireLick, getConeJid: () => 'cone_1' }) as any);
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: 'sub_scoop_2', // a non-cone parent → origin 'scoop'
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
    });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
    expect(mgr.getRun(runId)!.origin).toBe('scoop');
    expect(fireLick).not.toHaveBeenCalled(); // scoop-origin surfaces via `workflow status`, not a lick
  });

  it('uses opts.runId verbatim when provided (instead of deps.makeRunId)', async () => {
    const makeRunId = vi.fn(() => 'minted-id');
    const mgr = createWorkflowRunManager(makeDeps({ makeRunId }) as any);
    const { runId } = await mgr.start({
      code: 'C',
      source: 'S',
      name: 'n',
      filename: 'f',
      parentJid: undefined,
      sentinel: 'WF_RESULT_x',
      ctx: {} as any,
      runId: 'command-supplied-id',
    });
    expect(runId).toBe('command-supplied-id');
    expect(makeRunId).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mgr.getRun('command-supplied-id')!.status).toBe('done'));
    // The result file keys off the SAME id the command minted for the scratch dir.
    expect(mgr.getRun('command-supplied-id')!.resultPath).toBe(
      '/shared/workflow-runs/command-supplied-id.json'
    );
  });

  it('publishWorkflowRunManager sets globalThis.__slicc_workflows', () => {
    delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY];
    const mgr = publishWorkflowRunManager(makeDeps() as any);
    expect((globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY]).toBe(mgr);
  });

  // The command's delegation to the published manager (`globalThis.__slicc_workflows`)
  // is wired in Task 7, so `createWorkflowCommand().execute(['run', ...])` now reaches
  // `mgr.start` via the shared global — no proxy hop.
  it('dual-mode: manager publishes in a no-DOM (offscreen/worker) context and the command resolves it via the shared global — no proxy', async () => {
    // Worker/offscreen has no DOM. vitest `environment: node` mirrors that, so a clean
    // construct+publish here IS the worker-context assertion (any window/document touch throws).
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');

    delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY];
    // Publish exactly as host.ts does — float-agnostic deps (sharedFs/processManager/fireLick/runRealm).
    const mgr = publishWorkflowRunManager(makeDeps() as any);
    expect((globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY]).toBe(mgr);

    // The command does NOT receive the manager by injection — it resolves it from the SAME
    // global key the host published under. That is the offscreen path: panel terminal
    // (offscreen-backed) → globalThis.__slicc_workflows → manager, with no proxy hop.
    const spy = vi.spyOn(mgr, 'start');
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn 1`);
    const ctx = {
      fs: new VfsAdapter(fs),
      cwd: '/workspace',
      env: new Map<string, string>(),
      stdin: '',
      exec: Object.assign(async () => ({ stdout: '', stderr: '', exitCode: 0 }), {
        spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      }),
    } as any;
    const res = await createWorkflowCommand().execute(['run', '/workspace/wf.js'], ctx);
    expect(res.exitCode).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1); // command reached the published manager, not a proxy/local copy
  });
});

describe('evictOldRuns (memory bound)', () => {
  const mk = (id: string, status: string, at: string): WorkflowRunState =>
    ({
      id,
      status,
      startedAt: at,
      finishedAt: status === 'running' ? null : at,
      name: null,
      source: '',
    }) as unknown as WorkflowRunState;

  it('evicts the oldest TERMINAL runs over the cap, never a running one', () => {
    const runs = new Map<string, WorkflowRunState>([
      ['a', mk('a', 'done', '2026-01-01')],
      ['b', mk('b', 'running', '2026-01-02')],
      ['c', mk('c', 'done', '2026-01-03')],
    ]);
    const observers = new Map<string, Set<(s: WorkflowRunState) => void>>([
      ['a', new Set()],
      ['c', new Set()],
    ]);
    evictOldRuns(runs, observers, 2); // 3 runs, cap 2 → evict 1 oldest terminal = 'a'
    expect(runs.has('a')).toBe(false); // oldest terminal evicted
    expect(runs.has('b')).toBe(true); // running is never evicted
    expect(runs.has('c')).toBe(true);
    expect(observers.has('a')).toBe(false); // its observers dropped too
  });

  it('is a no-op at or under the cap', () => {
    const runs = new Map<string, WorkflowRunState>([['x', mk('x', 'done', 't')]]);
    evictOldRuns(runs, new Map(), 100);
    expect(runs.size).toBe(1);
  });
});
