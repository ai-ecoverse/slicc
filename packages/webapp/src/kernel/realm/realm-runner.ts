import type { CommandContext } from 'just-bash';
import type { Process, ProcessKind, ProcessManager, ProcessOwner } from '../process-manager.js';
import { attachRealmHost, type RealmHostHandle } from './realm-host.js';
import type { RealmPortLike } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmErrorMsg,
  RealmFsDeleteMsg,
  RealmFsWriteMsg,
  RealmInitMsg,
  RealmKind,
  RealmMountPoint,
  RealmOutputMsg,
} from './realm-types.js';
import { isSyncSabSupported, SAB_DEFAULT_WINDOW_BYTES, SAB_HEADER_BYTES } from './sync-sab-wire.js';

const OUTPUT_TAIL_MAX = 64 * 1024;

function appendOutputTail(current: string, chunk: string): string {
  if (!chunk) return current;
  const next = current + chunk;
  return next.length <= OUTPUT_TAIL_MAX ? next : next.slice(next.length - OUTPUT_TAIL_MAX);
}

export interface Realm {
  readonly controlPort: RealmPortLike;

  terminate(): void;

  readonly isolatedThread?: boolean;

  addEventListener?: (
    type: 'error' | 'messageerror',
    handler: (event: Event) => void,
    options?: AddEventListenerOptions
  ) => void;
  removeEventListener?: (type: 'error' | 'messageerror', handler: (event: Event) => void) => void;
}

export interface RealmFactoryArgs {
  kind: RealmKind;
  ctx: CommandContext;
}

export type RealmFactory = (args: RealmFactoryArgs) => Promise<Realm>;

export interface RunInRealmOptions {
  pm: ProcessManager;
  realmFactory: RealmFactory;
  owner: ProcessOwner;
  kind: RealmKind;

  code: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  filename: string;
  ctx: CommandContext;
  ppid?: number;

  realmArgv?: string[];

  stdin?: string;

  pyodideIndexURL?: string;

  pyodideAssetRoot?: string;

  pyodideMountDirs?: string[];

  opfsMountDbName?: string;

  mountPoints?: RealmMountPoint[];

  procKind?: ProcessKind;

  syncFsBridgeEnabled?: boolean;

  syncSabBytes?: number;

  onSpawn?: (proc: Process) => void;

  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;

  captureOutput?: boolean;
}

export interface RealmResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SIGNAL_EXIT_CODE = { SIGKILL: 137, SIGINT: 130, SIGTERM: 143 } as const;

export function realmKilledTrailer(elapsedMs: number, exitCode: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const shown =
    seconds < 10
      ? seconds
          .toFixed(2)
          .replace(/(\.\d*?)0+$/, '$1')
          .replace(/\.$/, '')
      : String(Math.round(seconds));
  return `--- killed after ${shown}s (exit ${exitCode}) ---\n`;
}

type PendingFsOp =
  | { op: 'write'; path: string; bytes: Uint8Array }
  | { op: 'delete'; path: string };

interface LiveRealmCapture {
  stdout: string;
  stderr: string;

  pendingByPath: Map<string, PendingFsOp>;

  captureOutput: boolean;
}

function dropPendingPaths(capture: LiveRealmCapture, paths: readonly string[]): void {
  for (const path of paths) capture.pendingByPath.delete(path);
}

function ingestLiveRealmMessage(
  data: { type?: string },
  capture: LiveRealmCapture,
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
): 'done' | 'error' | 'live' {
  if (data.type === 'realm-output') {
    const msg = data as RealmOutputMsg;
    if (msg.stream === 'stdout') {
      capture.stdout = capture.captureOutput
        ? capture.stdout + msg.chunk
        : appendOutputTail(capture.stdout, msg.chunk);
    } else {
      capture.stderr = capture.captureOutput
        ? capture.stderr + msg.chunk
        : appendOutputTail(capture.stderr, msg.chunk);
    }
    onOutput?.(msg.chunk, msg.stream);
    return 'live';
  }
  if (data.type === 'realm-fs-write') {
    const msg = data as RealmFsWriteMsg;
    capture.pendingByPath.set(msg.path, { op: 'write', path: msg.path, bytes: msg.bytes });
    return 'live';
  }
  if (data.type === 'realm-fs-delete') {
    const msg = data as RealmFsDeleteMsg;
    capture.pendingByPath.set(msg.path, { op: 'delete', path: msg.path });
    return 'live';
  }
  if (data.type === 'realm-done') return 'done';
  if (data.type === 'realm-error') return 'error';
  return 'live';
}

async function applyPendingFsOp(
  ctx: CommandContext,
  op: PendingFsOp,
  capture: LiveRealmCapture
): Promise<void> {
  try {
    if (op.op === 'write') {
      const writeFile = ctx.fs?.writeFile?.bind(ctx.fs);
      if (writeFile) await writeFile(op.path, op.bytes);
    } else {
      const rm = ctx.fs?.rm?.bind(ctx.fs);
      if (rm) await rm(op.path, { recursive: true });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = op.op === 'write' ? 'write' : 'delete';
    capture.stderr += `[sync-fs] ERROR: ${kind} of ${op.path} was NOT persisted: ${msg}\n`;
  }
}

async function applyCapturedFsOps(
  ops: readonly PendingFsOp[],
  ctx: CommandContext,
  capture: LiveRealmCapture
): Promise<void> {
  for (const op of ops) await applyPendingFsOp(ctx, op, capture);
}

function buildRealmInitMsg(
  opts: RunInRealmOptions,
  host: RealmHostHandle,
  syncSab: SharedArrayBuffer | undefined
): RealmInitMsg {
  return {
    type: 'realm-init',
    kind: opts.kind,
    code: opts.code,
    argv: opts.realmArgv ?? opts.argv,
    env: opts.env,
    cwd: opts.cwd,
    filename: opts.filename,
    stdin: opts.stdin,
    pyodideIndexURL: opts.pyodideIndexURL,
    pyodideAssetRoot: opts.pyodideAssetRoot,
    pyodideMountDirs: opts.pyodideMountDirs,
    opfsMountDbName: opts.opfsMountDbName,
    mountPoints: opts.mountPoints,
    ...(host.syncFsToken !== undefined ? { syncFsToken: host.syncFsToken } : {}),
    ...(syncSab ? { syncSab } : {}),
    ...(opts.captureOutput === false ? { captureOutput: false } : {}),
  };
}

export async function runInRealm(opts: RunInRealmOptions): Promise<RealmResult> {
  const procKind: ProcessKind = opts.procKind ?? 'jsh';
  const proc = opts.pm.spawn({
    kind: procKind,
    argv: opts.argv,
    cwd: opts.cwd,
    env: opts.env,
    owner: opts.owner,
    ppid: opts.ppid,
  });
  opts.onSpawn?.(proc);

  let realm: Realm;
  try {
    realm = await opts.realmFactory({ kind: opts.kind, ctx: opts.ctx });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.pm.exit(proc.pid, 1);
    return { stdout: '', stderr: `realm-runner: ${message}\n`, exitCode: 1 };
  }

  const syncSab = realm.isolatedThread ? allocateSyncSab(opts.syncSabBytes) : undefined;
  const capture: LiveRealmCapture = {
    stdout: '',
    stderr: '',
    pendingByPath: new Map(),
    captureOutput: opts.captureOutput !== false,
  };
  const host: RealmHostHandle = attachRealmHost(realm.controlPort, opts.ctx, {
    ...(opts.owner.scoopJid !== undefined ? { scoopJid: opts.owner.scoopJid } : {}),
    pm: opts.pm,
    owner: opts.owner,
    ppid: proc.pid,
    syncFsBridgeEnabled: Boolean(opts.syncFsBridgeEnabled) || syncSab !== undefined,
    ...(syncSab ? { syncSab } : {}),
    onHostFsMutation: (paths) => dropPendingPaths(capture, paths),
  });

  return new Promise<RealmResult>((resolve) => {
    let settling = false;
    let stopped = false;
    let unsubSignal: (() => void) | null = null;
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    let errorHandler: ((event: Event) => void) | null = null;
    let messageErrorHandler: ((event: Event) => void) | null = null;

    const hardStop = (): void => {
      if (stopped) return;
      stopped = true;
      if (messageHandler) realm.controlPort.removeEventListener('message', messageHandler);
      if (realm.removeEventListener) {
        if (errorHandler) realm.removeEventListener('error', errorHandler);
        if (messageErrorHandler) realm.removeEventListener('messageerror', messageErrorHandler);
      }
      unsubSignal?.();
      try {
        realm.terminate();
      } catch {}
    };

    const finish = (result: RealmResult, exitForPm: number | null): void => {
      hardStop();
      host.dispose();
      opts.pm.exit(proc.pid, exitForPm);
      resolve(result);
    };

    const settleDone = (result: RealmResult, exitForPm: number | null): void => {
      if (settling) return;
      settling = true;

      void Promise.resolve().then(() => finish(result, exitForPm));
    };

    const settleKill = (exitCode: number): void => {
      if (settling) return;
      settling = true;

      void Promise.resolve().then(() => {
        const ops = [...capture.pendingByPath.values()];
        capture.pendingByPath.clear();
        hardStop();
        void applyCapturedFsOps(ops, opts.ctx, capture).finally(() => {
          const trailer = realmKilledTrailer(Date.now() - proc.startedAt, exitCode);
          finish({ stdout: capture.stdout, stderr: capture.stderr + trailer, exitCode }, exitCode);
        });
      });
    };

    messageHandler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      const kind = ingestLiveRealmMessage(data, capture, opts.onOutput);
      if (kind === 'done') {
        const done = event.data as RealmDoneMsg;
        settleDone(
          { stdout: done.stdout, stderr: done.stderr, exitCode: done.exitCode },
          done.exitCode
        );
      } else if (kind === 'error') {
        const err = event.data as RealmErrorMsg;
        settleDone(
          { stdout: capture.stdout, stderr: capture.stderr + err.message + '\n', exitCode: 1 },
          1
        );
      }
    };

    errorHandler = (event: Event): void => {
      event.preventDefault?.();
      const message = (event as ErrorEvent).message ?? 'realm error';
      settleDone(
        { stdout: capture.stdout, stderr: capture.stderr + message + '\n', exitCode: 1 },
        1
      );
    };

    messageErrorHandler = (): void => {
      settleDone(
        {
          stdout: capture.stdout,
          stderr: capture.stderr + 'realm-runner: worker message could not be deserialized\n',
          exitCode: 1,
        },
        1
      );
    };

    unsubSignal = opts.pm.onSignal((signaled, sig) => {
      if (signaled.pid !== proc.pid) return;
      const exitCode = SIGNAL_EXIT_CODE[sig as keyof typeof SIGNAL_EXIT_CODE];
      if (exitCode !== undefined) settleKill(exitCode);
    });

    realm.controlPort.addEventListener('message', messageHandler);
    if (realm.addEventListener) {
      realm.addEventListener('error', errorHandler);
      realm.addEventListener('messageerror', messageErrorHandler);
    }

    realm.controlPort.postMessage(buildRealmInitMsg(opts, host, syncSab));
  });
}

export function allocateSyncSab(windowBytes?: number): SharedArrayBuffer | undefined {
  if (!isSyncSabSupported()) return undefined;
  try {
    return new SharedArrayBuffer(SAB_HEADER_BYTES + (windowBytes ?? SAB_DEFAULT_WINDOW_BYTES));
  } catch {
    return undefined;
  }
}
