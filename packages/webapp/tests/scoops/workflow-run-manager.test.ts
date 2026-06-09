import { describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import {
  createWorkflowRunManager,
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
    // matches on argv ([0]==='workflow' && [2]===runId), NOT kind, so kind here is just
    // realistic fixture data — must match reality so the test isn't misleading. argv[2]
    // is the unique runId the manager threads in (makeRunId returns 'run1' here).
    spawnHandler?.({ pid: 4242, kind: 'jsh', argv: ['workflow', 'f', 'run1'] });
    expect(mgr.getRun(runId)!.pid).toBe(4242);
    realmDone.resolve({ stdout: `WF_RESULT_x${JSON.stringify({})}`, stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
  });

  it('concurrent same-file runs capture DISTINCT pids (no aliasing) — matched by runId in argv[2]', async () => {
    // Every `start()` registers its own spawn listener. Capture them all so we can
    // replay each run's spawn event to every listener — exactly what the real PM does
    // (it broadcasts each spawn to all subscribers). Each listener must only claim the
    // pid whose argv[2] matches ITS runId.
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

    // Broadcast each run's spawn (identical argv[0..1], unique argv[2]=runId) to ALL listeners.
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
