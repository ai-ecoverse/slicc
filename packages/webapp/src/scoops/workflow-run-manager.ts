import { createLogger } from '../base/logger.js';
import type {
  CommandContextLike,
  ExecResultLike,
  WorkflowRunManager,
  WorkflowRunState,
  WorkflowStartOptions,
} from '../shell/workflow-run-handle.js';
import { WORKFLOW_MANAGER_GLOBAL_KEY } from '../shell/workflow-run-handle.js';

export type {
  CommandContextLike,
  ExecResultLike,
  WorkflowRunManager,
  WorkflowRunState,
  WorkflowStartOptions,
} from '../shell/workflow-run-handle.js';
export { WORKFLOW_MANAGER_GLOBAL_KEY } from '../shell/workflow-run-handle.js';

const log = createLogger('workflow-run-manager');
const RUNS_DIR = '/shared/workflow-runs';

const MAX_LOG_LINES = 1000;
const MAX_RETAINED_RUNS = 100;

export interface WorkflowRunManagerDeps {
  sharedFs: {
    mkdir(p: string, o: { recursive: boolean }): Promise<void>;
    writeFile(p: string, data: string): Promise<void>;
  };

  getStartingRoot: (parentJid: string) => { jid: string; lickTarget?: string } | null;
  fireLick: (event: import('./lick-manager.js').LickEvent) => void;
  processManager: {
    on(
      event: 'spawn',
      fn: (proc: { pid: number; argv: readonly string[]; kind: string }) => void
    ): () => void;
  };

  runRealm: (code: string, argv: string[], ctx: CommandContextLike) => Promise<ExecResultLike>;
  makeRunId: () => string;
  splitResult: (
    stdout: string,
    sentinel: string
  ) => { result: unknown; log: string; hadResult: boolean };
}

function classifyOrigin(
  deps: WorkflowRunManagerDeps,
  parentJid: string | undefined
): { origin: WorkflowRunState['origin']; lickTarget?: string } {
  if (parentJid === undefined) return { origin: 'terminal' };
  const root = deps.getStartingRoot(parentJid);
  if (!root) return { origin: 'scoop' };
  return { origin: 'cone', lickTarget: root.lickTarget };
}

export function createWorkflowRunManager(deps: WorkflowRunManagerDeps): WorkflowRunManager {
  const runs = new Map<string, WorkflowRunState>();
  const observers = new Map<string, Set<(s: WorkflowRunState) => void>>();

  const notify = (id: string) => {
    const s = runs.get(id);
    if (!s) return;
    for (const h of observers.get(id) ?? []) {
      try {
        h(s);
      } catch (e) {
        log.warn('observeRun handler threw', e);
      }
    }
  };

  const wrapRunCtx = (ctx: CommandContextLike, runId: string) =>
    wrapCtx(ctx, runId, runs, () => notify(runId));

  async function start(opts: WorkflowStartOptions): Promise<{ runId: string }> {
    const runId = opts.runId ?? deps.makeRunId();
    const sentinel = opts.sentinel;
    const starter = classifyOrigin(deps, opts.parentJid);
    const state: WorkflowRunState = {
      id: runId,
      name: opts.name,
      source: opts.source,
      origin: starter.origin,
      lickTarget: starter.lickTarget,
      status: 'running',
      currentPhase: null,
      agentsStarted: 0,
      agentsDone: 0,
      logs: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      resultPath: null,
      preview: null,
      error: null,
      pid: null,
    };
    runs.set(runId, state);
    evictOldRuns(runs, observers);

    const wrappedCtx = wrapRunCtx(opts.ctx, runId);
    const offSpawn = capturePid(deps.processManager, state, runId, () => notify(runId));
    void deps
      .runRealm(opts.code, ['workflow', opts.filename, runId], wrappedCtx)
      .then((result) => finish(runId, sentinel, result))
      .catch((err) => fail(runId, err instanceof Error ? err.message : String(err)))
      .finally(() => offSpawn())
      .catch((e) => log.warn('workflow run lifecycle error', e));

    return { runId };
  }

  async function finish(runId: string, sentinel: string, result: ExecResultLike): Promise<void> {
    const { result: value, hadResult } = deps.splitResult(result.stdout, sentinel);
    if (result.exitCode === 137) {
      return complete(runId, 'killed', null, result.stderr || 'killed (SIGKILL)');
    }
    if (result.exitCode !== 0 || !hadResult) {
      return complete(
        runId,
        'error',
        null,
        result.stderr || (hadResult ? `exit ${result.exitCode}` : 'script produced no result')
      );
    }
    return complete(runId, 'done', value, null);
  }

  function fail(runId: string, error: string): Promise<void> {
    return complete(runId, 'error', null, error);
  }

  async function complete(
    runId: string,
    status: 'done' | 'error' | 'killed',
    value: unknown,
    error: string | null
  ): Promise<void> {
    const state = runs.get(runId);
    if (!state) return;
    if (state.status !== 'running' && state.status !== 'paused') return;
    const resultPath = `${RUNS_DIR}/${runId}.json`;

    const finishedAt = new Date().toISOString();
    try {
      await deps.sharedFs.mkdir(RUNS_DIR, { recursive: true });
      await deps.sharedFs.writeFile(
        resultPath,
        JSON.stringify(
          {
            name: state.name,
            status,
            result: status === 'done' ? value : null,
            error,
            logs: state.logs,
            startedAt: state.startedAt,
            finishedAt,
          },
          null,
          2
        )
      );
      state.resultPath = resultPath;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('failed to write run result file', { runId, resultPath, error: msg });
      error = `result file write failed: ${msg}`;
      if (status === 'done') status = 'error';
    }
    state.status = status;
    state.error = error;
    state.finishedAt = finishedAt;
    state.preview = status === 'done' ? previewOf(value) : (error ?? '');
    notify(runId);
    deliver(state);
  }

  function deliver(state: WorkflowRunState): void {
    if (state.origin !== 'cone') return;
    deps.fireLick({
      type: 'workflow',

      targetScoop: state.lickTarget,
      workflowRunId: state.id,
      workflowName: state.name ?? undefined,
      resultPath: state.resultPath ?? undefined,
      preview: state.preview ?? state.error ?? undefined,
      timestamp: new Date().toISOString(),
      body: { runId: state.id, status: state.status, error: state.error },
    });
  }

  return {
    start,
    getRun: (id) => runs.get(id) ?? null,
    listRuns: () => Array.from(runs.values()),
    observeRun(id, handler) {
      let set = observers.get(id);
      if (!set) {
        set = new Set();
        observers.set(id, set);
      }
      set.add(handler);

      const current = runs.get(id);
      if (current) {
        try {
          handler(current);
        } catch (e) {
          log.warn('observeRun handler threw on initial state', e);
        }
      }
      return () => set!.delete(handler);
    },
  };
}

export function publishWorkflowRunManager(deps: WorkflowRunManagerDeps): WorkflowRunManager {
  const mgr = createWorkflowRunManager(deps);
  (globalThis as Partial<Record<typeof WORKFLOW_MANAGER_GLOBAL_KEY, WorkflowRunManager>>)[
    WORKFLOW_MANAGER_GLOBAL_KEY
  ] = mgr;
  log.info('workflow run manager published on globalThis.__slicc_workflows');
  return mgr;
}

function previewOf(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return (s ?? 'null').slice(0, 200);
}

export function evictOldRuns(
  runs: Map<string, WorkflowRunState>,
  observers: Map<string, Set<(s: WorkflowRunState) => void>>,
  max = MAX_RETAINED_RUNS
): void {
  if (runs.size <= max) return;
  const terminal = [...runs.values()]
    .filter((s) => s.status !== 'running' && s.status !== 'paused')
    .sort((a, b) => (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt));
  let over = runs.size - max;
  for (const s of terminal) {
    if (over <= 0) break;
    runs.delete(s.id);
    observers.delete(s.id);
    over--;
  }
}

function capturePid(
  processManager: WorkflowRunManagerDeps['processManager'],
  state: WorkflowRunState,
  runId: string,
  notify: () => void
): () => void {
  const offSpawn = processManager.on('spawn', (proc) => {
    if (state.pid === null && proc.argv.includes(runId)) {
      state.pid = proc.pid;
      notify();
      offSpawn();
    }
  });
  return offSpawn;
}

function wrapCtx(
  ctx: CommandContextLike,
  runId: string,
  runs: Map<string, WorkflowRunState>,
  notify: () => void
): CommandContextLike {
  const realExec = ctx.exec;
  if (!realExec) return ctx;
  const tappedExec = (async (
    cmd: string,
    opts?: { cwd?: string; args?: string[] }
  ): Promise<ExecResultLike> => {
    if (cmd === '__wf_progress') return tapProgress(runs, runId, opts?.args ?? [], notify);
    if (cmd === 'agent') return tapAgent(runs, runId, () => realExec(cmd, opts), notify);
    return realExec(cmd, opts);
  }) as CommandContextLike['exec'];

  (tappedExec as { spawn?: unknown }).spawn = (ctx.exec as { spawn?: unknown }).spawn;
  return { ...ctx, exec: tappedExec };
}

function tapProgress(
  runs: Map<string, WorkflowRunState>,
  runId: string,
  args: string[],
  notify: () => void
): ExecResultLike {
  const s = runs.get(runId);
  if (s && s.status === 'running') {
    const [kind, text = ''] = args;
    if (kind === 'phase') {
      s.currentPhase = text;
      s.logs.push(text);
    } else if (kind === 'log') {
      s.logs.push(text);
    }
    if (s.logs.length > MAX_LOG_LINES) s.logs.splice(0, s.logs.length - MAX_LOG_LINES);
    notify();
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

async function tapAgent(
  runs: Map<string, WorkflowRunState>,
  runId: string,
  passThrough: () => Promise<ExecResultLike>,
  notify: () => void
): Promise<ExecResultLike> {
  const s = runs.get(runId);
  if (s && s.status === 'running') {
    s.agentsStarted++;
    notify();
  }
  try {
    return await passThrough();
  } finally {
    const s2 = runs.get(runId);
    if (s2 && s2.status === 'running') {
      s2.agentsDone++;
      notify();
    }
  }
}
