import { describe, expect, it, vi } from 'vitest';
import { createWorkflowRunManager } from '../../src/scoops/workflow-run-manager.js';

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
    mgr.observeRun(runId, (s) => states.push(s.status));
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
});
