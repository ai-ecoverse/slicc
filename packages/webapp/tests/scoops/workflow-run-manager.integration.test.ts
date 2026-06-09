import { expect, it, vi } from 'vitest';
import type { CommandContextLike, ExecResultLike } from '../../src/scoops/workflow-run-manager.js';
import { createWorkflowRunManager } from '../../src/scoops/workflow-run-manager.js';
import { splitSentinel } from '../../src/shell/supplemental-commands/workflow-script.js';

it('backgrounds a fan-out: progress advances, file written, cone lick fired', async () => {
  const writes: Array<{ path: string; data: string }> = [];
  const fireLick = vi.fn();
  const sentinel = 'WF_RESULT_int';
  const mgr = createWorkflowRunManager({
    sharedFs: {
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (p: string, d: string) => {
        writes.push({ path: p, data: d });
      }),
    } as any,
    getConeJid: () => 'cone_1',
    fireLick,
    processManager: { on: vi.fn(() => () => {}) } as any,
    runRealm: async (
      _c: string,
      _a: string[],
      ctx: CommandContextLike
    ): Promise<ExecResultLike> => {
      await ctx.exec!('__wf_progress', { args: ['phase', 'Find'] });
      // two agents concurrently:
      await Promise.all([
        ctx.exec!('agent', { args: ['--read-only', '/workspace/', '/s', '*', 'a'] }),
        ctx.exec!('agent', { args: ['--read-only', '/workspace/', '/s', '*', 'b'] }),
      ]);
      return {
        stdout: 'logline\n' + sentinel + JSON.stringify({ confirmed: 2 }),
        stderr: '',
        exitCode: 0,
      };
    },
    makeRunId: () => 'int1',
    splitResult: (stdout: string) => splitSentinel(stdout, sentinel),
  } as any);

  const { runId } = await mgr.start({
    code: 'C',
    source: 'S',
    name: 'audit',
    filename: 'wf.js',
    parentJid: 'cone_1',
    ctx: {
      cwd: '/',
      env: new Map(),
      stdin: '',
      exec: Object.assign(async () => ({ stdout: '', stderr: '', exitCode: 0 }), {
        spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      }),
    } as any,
    sentinel,
  });

  await vi.waitFor(() => expect(mgr.getRun(runId)!.status).toBe('done'));
  const s = mgr.getRun(runId)!;
  expect(s.currentPhase).toBe('Find');
  expect(s.agentsStarted).toBe(2);
  expect(s.agentsDone).toBe(2);
  expect(writes[0].path).toBe('/shared/workflow-runs/int1.json');
  expect(JSON.parse(writes[0].data).result).toEqual({ confirmed: 2 });
  expect(fireLick).toHaveBeenCalledTimes(1);
  expect(fireLick.mock.calls[0][0]).toMatchObject({
    type: 'workflow',
    workflowName: 'audit',
    resultPath: '/shared/workflow-runs/int1.json',
  });
});
