export const WORKFLOW_MANAGER_GLOBAL_KEY = '__slicc_workflows';

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

  lickTarget?: string;
}

export interface WorkflowStartOptions {
  code: string;
  source: string;
  name: string | null;
  filename: string;
  parentJid: string | undefined;
  ctx: CommandContextLike;

  sentinel: string;

  runId?: string;
}

export interface CommandContextLike {
  cwd: string;
  env: Map<string, string>;

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

  getRun(runId: string): Readonly<WorkflowRunState> | null;
  listRuns(): readonly Readonly<WorkflowRunState>[];
  observeRun(runId: string, handler: (s: WorkflowRunState) => void): () => void;
}
