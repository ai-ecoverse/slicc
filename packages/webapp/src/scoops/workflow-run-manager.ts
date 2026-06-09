// packages/webapp/src/scoops/workflow-run-manager.ts
import { createLogger } from '../core/logger.js';

const log = createLogger('workflow-run-manager');
export const WORKFLOW_MANAGER_GLOBAL_KEY = '__slicc_workflows';
const RUNS_DIR = '/shared/workflow-runs';

export interface WorkflowRunState {
  id: string;
  name: string | null;
  source: string;
  origin: 'cone' | 'scoop' | 'terminal';
  status: 'running' | 'paused' | 'done' | 'error' | 'killed';
  currentPhase: string | null;
  agentsStarted: number;
  agentsDone: number;
  logs: string[];
  startedAt: string;
  finishedAt: string | null;
  resultPath: string | null;
  preview: string | null;
  error: string | null;
  pid: number | null;
}

export interface WorkflowStartOptions {
  code: string;
  source: string;
  name: string | null;
  filename: string;
  parentJid: string | undefined;
  ctx: CommandContextLike;
  /**
   * The result sentinel. Built ONCE by the command (Task 7) and passed into BOTH
   * `buildWorkflowCode({ sentinel })` (the realm code) and here, so `splitResult`
   * matches exactly what the realm emits. The manager does not invent its own.
   */
  sentinel: string;
}

// Minimal shell ctx shape the manager needs (subset of just-bash CommandContext).
export interface CommandContextLike {
  cwd: string;
  env: Map<string, string>;
  // stdin is never read by the manager (the tap reads cwd/exec); typed loosely so the real
  // just-bash CommandContext (branded ByteString stdin) is assignable without a lossy double-cast.
  stdin: unknown;
  exec?: ((cmd: string, opts?: { cwd?: string; args?: string[] }) => Promise<ExecResultLike>) & {
    spawn?: (argv: string[]) => Promise<ExecResultLike>;
  };
  fs?: unknown;
}
export interface ExecResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkflowRunManagerDeps {
  sharedFs: {
    mkdir(p: string, o: { recursive: boolean }): Promise<void>;
    writeFile(p: string, data: string): Promise<void>;
  };
  getConeJid: () => string | undefined;
  fireLick: (event: import('./lick-manager.js').LickEvent) => void;
  processManager: {
    // `proc` is structurally compatible with the kernel `Process` (argv is
    // `readonly string[]`, kind is a `ProcessKind` union widened to string)
    // so the concrete `ProcessManager` is assignable without a cast at the
    // host call site.
    on(
      event: 'spawn',
      fn: (proc: { pid: number; argv: readonly string[]; kind: string }) => void
    ): () => void;
  };
  // Injectable launch — production wires executeJsCode; tests stub it.
  runRealm: (code: string, argv: string[], ctx: CommandContextLike) => Promise<ExecResultLike>;
  makeRunId: () => string;
  splitResult: (
    stdout: string,
    sentinel: string
  ) => { result: unknown; log: string; hadResult: boolean };
}

export interface WorkflowRunManager {
  start(opts: WorkflowStartOptions): Promise<{ runId: string }>;
  getRun(runId: string): WorkflowRunState | null;
  listRuns(): WorkflowRunState[];
  observeRun(runId: string, handler: (s: WorkflowRunState) => void): () => void;
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

  const classifyOrigin = (parentJid: string | undefined): WorkflowRunState['origin'] => {
    if (parentJid === undefined) return 'terminal';
    return parentJid === deps.getConeJid() ? 'cone' : 'scoop';
  };

  const wrapRunCtx = (ctx: CommandContextLike, runId: string) =>
    wrapCtx(ctx, runId, runs, () => notify(runId));

  async function start(opts: WorkflowStartOptions): Promise<{ runId: string }> {
    const runId = deps.makeRunId();
    const sentinel = opts.sentinel; // built by the command; never invented here
    const state: WorkflowRunState = {
      id: runId,
      name: opts.name,
      source: opts.source,
      origin: classifyOrigin(opts.parentJid),
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

    // The manager is ALWAYS non-blocking: it kicks off the realm and returns the runId
    // immediately. `--wait` is NOT handled here — the command bypasses the manager entirely
    // for `--wait` (Task 7 Step 4) and runs the SP1 inline path, so `start` never awaits.
    const wrappedCtx = wrapRunCtx(opts.ctx, runId);
    const offSpawn = deps.processManager.on('spawn', (proc) => {
      // Match by the unique runId in argv[2], NOT by kind or filename. Filename
      // is NOT unique (two concurrent runs of the same file — and ALL `--script`
      // runs, which share `<workflow>` — would alias to whichever pid spawned
      // first). The realm argv is `['workflow', filename, runId]`; `runInRealm`
      // registers the process with that full argv (kind is irrelevant — it's
      // 'jsh' for every realm-JS process), so argv[2] === runId is the only
      // reliable per-run discriminator.
      if (state.pid === null && proc.argv[0] === 'workflow' && proc.argv[2] === runId) {
        state.pid = proc.pid;
        notify(runId);
      }
    });
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
      // SIGKILL (kill -KILL) → 'killed', not 'error' (spec §8).
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

  // Thrown launch error (realm crash) → error.
  function fail(runId: string, error: string): Promise<void> {
    return complete(runId, 'error', null, error);
  }

  // Single completion path: writes the run file for success AND failure (spec §8
  // requires errors captured in the file too), updates state, notifies, delivers.
  async function complete(
    runId: string,
    status: 'done' | 'error' | 'killed',
    value: unknown,
    error: string | null
  ): Promise<void> {
    const state = runs.get(runId);
    if (!state) return;
    const resultPath = `${RUNS_DIR}/${runId}.json`;
    // One timestamp per completion so the run file and the in-memory state agree.
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
      log.warn('failed to write run result file', e); // best-effort; state still updates
    }
    state.status = status;
    state.error = error;
    state.finishedAt = finishedAt;
    state.preview = status === 'done' ? previewOf(value) : (error ?? '');
    notify(runId);
    deliver(state);
  }

  function deliver(state: WorkflowRunState): void {
    if (state.origin !== 'cone') return; // terminal/scoop: surfaced via `workflow status`
    deps.fireLick({
      type: 'workflow',
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
      // Emit current state on subscribe so a late subscriber never misses a
      // terminal state (the run may already be done by the time it attaches).
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

/**
 * Bootstrap helper for the kernel host. Constructs the run manager and
 * publishes it on `globalThis.__slicc_workflows` so the `workflow`
 * supplemental command (and the cone) can resolve it the same way the
 * `agent` command resolves `__slicc_agent`. Returns the manager so the
 * caller can also hold a direct reference.
 */
export function publishWorkflowRunManager(deps: WorkflowRunManagerDeps): WorkflowRunManager {
  const mgr = createWorkflowRunManager(deps);
  (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY] = mgr;
  log.info('workflow run manager published on globalThis.__slicc_workflows');
  return mgr;
}

function previewOf(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return (s ?? 'null').slice(0, 200);
}

// Tap the run's `ctx.exec` (the lowering point `realm-host.dispatchExec` calls — NOT
// `ctx.exec.spawn`): `__wf_progress` calls are intercepted (phase/log → state, never
// passed through to a real command); `agent` calls bump agentsStarted/Done around a
// pass-through; everything else passes through unchanged. Returns `ctx` unchanged when it
// has no `exec` so runs whose ctx lacks an exec surface stay transparent.
//
// PER-RUN EXEC ISOLATION INVARIANT (spec §5 — SP2 accepts a narrow, documented risk):
// we reuse the launching `ctx.exec` rather than backing each run with its own shell. The
// documented workflow API (`agent`/`parallel`/`pipeline`/`phase`/`log`) never mutates the
// shell's cwd/lastEnv, so in-contract workflows are safe. The undocumented internal
// `__execSpawn(['cd',…])` / `__execSpawn(['secret','set',…])` escape hatch CAN corrupt the
// launching shell when backgrounded — out of contract, pre-existing in SP1, deferred to SP6
// (hide `__execSpawn` behind an IIFE, or give each run its own cwd/lastEnv-owning shell).
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
    const args = opts?.args ?? [];
    if (cmd === '__wf_progress') {
      const kind = args[0];
      const text = args[1] ?? '';
      const s = runs.get(runId);
      if (s) {
        if (kind === 'phase') {
          s.currentPhase = text;
          s.logs.push(text);
        } else if (kind === 'log') {
          s.logs.push(text);
        }
        notify();
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (cmd === 'agent') {
      const s = runs.get(runId);
      if (s) {
        s.agentsStarted++;
        notify();
      }
      try {
        return await realExec(cmd, opts);
      } finally {
        const s2 = runs.get(runId);
        if (s2) {
          s2.agentsDone++;
          notify();
        }
      }
    }
    return realExec(cmd, opts);
  }) as CommandContextLike['exec'];
  // Preserve the .spawn surface realm-host doesn't use, but keep parity.
  (tappedExec as { spawn?: unknown }).spawn = (ctx.exec as { spawn?: unknown }).spawn;
  return { ...ctx, exec: tappedExec };
}
