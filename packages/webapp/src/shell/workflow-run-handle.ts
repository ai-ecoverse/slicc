/**
 * The workflow run manager's contract, declared in the shell layer.
 *
 * The manager itself lives in `scoops/` (it drives realms and licks), but the
 * `workflow` shell command only ever reads run state and starts runs. The
 * layer stack (`base/fs → shell/git → cdp → tools → core → scoops → ui`)
 * forbids `shell/` from importing `scoops/`, so the types and the global key
 * live here and `scoops/workflow-run-manager.ts` imports them downward and
 * re-exports them for its existing consumers — the same inversion
 * `shell/sprinkle-manager-handle.ts` uses for the sprinkle manager.
 */

/** Where the scoops layer publishes the live manager for the shell to find. */
export const WORKFLOW_MANAGER_GLOBAL_KEY = '__slicc_workflows';

export interface WorkflowRunState {
  id: string;
  name: string | null;
  source: string;
  origin: 'cone' | 'scoop' | 'terminal';
  status:
    | 'running'
    /** reserved for SP5 pause/resume — not written in SP2; the terminal-status guards already tolerate it */
    | 'paused'
    | 'done'
    | 'error'
    | 'killed';
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
  /**
   * Optional caller-supplied run id. When present the manager uses it verbatim
   * instead of minting one via `deps.makeRunId()`. The command threads the SAME
   * id it baked into the per-run scratch cwd (`/shared/workflow-runs/<id>/scratch/`)
   * so the scratch tree, the result file (`/shared/workflow-runs/<id>.json`),
   * `workflow status <id>`, and the realm argv all key off one id.
   */
  runId?: string;
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

export interface WorkflowRunManager {
  start(opts: WorkflowStartOptions): Promise<{ runId: string }>;
  // Returns are `Readonly` — consumers (the `workflow` command) only ever read
  // run state; the manager is the sole mutator.
  getRun(runId: string): Readonly<WorkflowRunState> | null;
  listRuns(): readonly Readonly<WorkflowRunState>[];
  observeRun(runId: string, handler: (s: WorkflowRunState) => void): () => void;
}
