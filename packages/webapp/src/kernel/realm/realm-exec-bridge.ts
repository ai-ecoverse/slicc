import type { RealmRpcClient } from './realm-rpc.js';
import type { SyncFsCache, SyncFsSnapshot } from './sync-fs-cache.js';

export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export type ExecStartOptions = {
  stdin?: string;

  stdinKind?: 'text' | 'bytes';

  args?: string[];
};

export type ExecHandle = {
  kill(sig?: string): Promise<boolean>;
  stdin: { write(chunk: string): void; end(): void };
  done: Promise<ExecResult>;
};

export type ExecBridge = ((cmd: string) => Promise<ExecResult>) & {
  spawn: (argv: string[]) => Promise<ExecResult>;
  exec: (cmd: string) => Promise<ExecResult>;
  start: (commandOrArgv: string | string[], opts?: ExecStartOptions) => ExecHandle;
};

function killExitCode(sig?: string): number {
  if (sig === 'SIGKILL') return 137;
  if (sig === 'SIGINT') return 130;
  return 143;
}

export function createExecBridge(
  rpc: RealmRpcClient,
  syncFs?: SyncFsCache,
  cwd?: string,
  writeStderr?: (value: unknown) => void
): ExecBridge {
  const flushBeforeExec = async (): Promise<void> => {
    if (!syncFs?.wasUsed()) return;
    const mutations = syncFs.getMutations();
    if (mutations.created.length || mutations.modified.length || mutations.deleted.length) {
      try {
        await rpc.call('vfs', 'flushWrites', [mutations]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[realm-exec] pre-exec sync-fs flush failed (will retry at exit): ${msg}`);
        return;
      }
    }
    syncFs.resetBaseline();
  };

  const resnapshotAfterExec = async (preserveMutations = false): Promise<void> => {
    if (!syncFs?.wasUsed()) return;
    try {
      const snapshot = await rpc.call<SyncFsSnapshot>('vfs', 'snapshot', [cwd]);
      if (preserveMutations) syncFs.applySnapshotPreservingMutations(snapshot);
      else syncFs.applySnapshot(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr?.(`[sync-fs] re-snapshot after exec failed: ${msg}\n`);
    }
  };

  const execRun = async (command: string): Promise<ExecResult> => {
    await flushBeforeExec();
    try {
      return await rpc.call<ExecResult>('exec', 'run', [command]);
    } finally {
      await resnapshotAfterExec();
    }
  };

  const spawn = async (argv: string[]): Promise<ExecResult> => {
    await flushBeforeExec();
    try {
      return await rpc.call<ExecResult>('exec', 'spawn', [argv]);
    } finally {
      await resnapshotAfterExec();
    }
  };

  let nextSpawnId = 1;

  const start = (commandOrArgv: string | string[], opts?: ExecStartOptions): ExecHandle => {
    const spawnId = nextSpawnId++;
    const chunks: string[] = [];
    let started = false;

    let firing = false;

    let killed = false;
    let resolveDone!: (value: ExecResult) => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<ExecResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const fire = (): void => {
      if (started || killed) return;

      if (firing) return;
      firing = true;

      const buffered = chunks.length > 0 ? chunks.join('') : opts?.stdin;
      const startOpts: ExecStartOptions = {};
      if (buffered !== undefined) startOpts.stdin = buffered;
      if (opts?.stdinKind !== undefined) startOpts.stdinKind = opts.stdinKind;
      if (opts?.args !== undefined) startOpts.args = opts.args;

      void (async () => {
        try {
          await flushBeforeExec();

          if (killed) {
            await resnapshotAfterExec(true);
            return;
          }

          started = true;
          const result = await rpc.call<ExecResult>('exec', 'start', [
            spawnId,
            commandOrArgv,
            startOpts,
          ]);
          await resnapshotAfterExec(true);
          resolveDone(result);
        } catch (err: unknown) {
          await resnapshotAfterExec(true);
          rejectDone(err);
        }
      })();
    };
    return {
      kill: (sig?: string): Promise<boolean> => {
        if (started) return rpc.call('exec', 'kill', [spawnId, sig]);

        killed = true;
        resolveDone({ stdout: '', stderr: '', exitCode: killExitCode(sig) });
        return Promise.resolve(true);
      },
      stdin: {
        write: (chunk: string): void => {
          if (!started && !killed) chunks.push(chunk);
        },
        end: (): void => fire(),
      },
      done,
    };
  };

  const execBridge = Object.assign(execRun, {
    spawn,
    start,
  }) as ExecBridge;
  execBridge.exec = execBridge;
  return execBridge;
}
