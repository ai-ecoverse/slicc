import type { CommandContext } from 'just-bash';
import type { ProcessKind, ProcessManager, ProcessOwner } from '../process-manager.js';
import { attachRealmHost, type RealmHostHandle } from './realm-host.js';
import type { RealmPortLike } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmErrorMsg,
  RealmInitMsg,
  RealmKind,
  RealmMountPoint,
} from './realm-types.js';
import { isSyncSabSupported, SAB_DEFAULT_WINDOW_BYTES, SAB_HEADER_BYTES } from './sync-sab-wire.js';

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
}

export interface RealmResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

  let realm: Realm;
  try {
    realm = await opts.realmFactory({ kind: opts.kind, ctx: opts.ctx });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.pm.exit(proc.pid, 1);
    return { stdout: '', stderr: `realm-runner: ${message}\n`, exitCode: 1 };
  }

  const syncSab = realm.isolatedThread ? allocateSyncSab(opts.syncSabBytes) : undefined;
  const host: RealmHostHandle = attachRealmHost(realm.controlPort, opts.ctx, {
    ...(opts.owner.scoopJid !== undefined ? { scoopJid: opts.owner.scoopJid } : {}),
    pm: opts.pm,
    owner: opts.owner,
    ppid: proc.pid,
    syncFsBridgeEnabled: Boolean(opts.syncFsBridgeEnabled) || syncSab !== undefined,
    ...(syncSab ? { syncSab } : {}),
  });

  return new Promise<RealmResult>((resolve) => {
    let settled = false;
    let unsubSignal: (() => void) | null = null;
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    let errorHandler: ((event: Event) => void) | null = null;
    let messageErrorHandler: ((event: Event) => void) | null = null;

    const cleanup = (): void => {
      if (messageHandler) realm.controlPort.removeEventListener('message', messageHandler);
      if (realm.removeEventListener) {
        if (errorHandler) realm.removeEventListener('error', errorHandler);
        if (messageErrorHandler) realm.removeEventListener('messageerror', messageErrorHandler);
      }
      unsubSignal?.();
      host.dispose();
    };

    const settle = (result: RealmResult, exitForPm: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        realm.terminate();
      } catch {}
      opts.pm.exit(proc.pid, exitForPm);
      resolve(result);
    };

    messageHandler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      if (data?.type === 'realm-done') {
        const done = event.data as RealmDoneMsg;
        settle(
          { stdout: done.stdout, stderr: done.stderr, exitCode: done.exitCode },
          done.exitCode
        );
      } else if (data?.type === 'realm-error') {
        const err = event.data as RealmErrorMsg;
        settle({ stdout: '', stderr: err.message + '\n', exitCode: 1 }, 1);
      }
    };

    errorHandler = (event: Event): void => {
      const message = (event as ErrorEvent).message ?? 'realm error';
      settle({ stdout: '', stderr: message + '\n', exitCode: 1 }, 1);
    };

    messageErrorHandler = (): void => {
      settle(
        {
          stdout: '',
          stderr: 'realm-runner: worker message could not be deserialized\n',
          exitCode: 1,
        },
        1
      );
    };

    unsubSignal = opts.pm.onSignal((signaled, sig) => {
      if (signaled.pid !== proc.pid) return;
      if (sig === 'SIGKILL') {
        settle({ stdout: '', stderr: '', exitCode: 137 }, 137);
      } else if (sig === 'SIGINT') {
        settle({ stdout: '', stderr: '', exitCode: 130 }, 130);
      } else if (sig === 'SIGTERM') {
        settle({ stdout: '', stderr: '', exitCode: 143 }, 143);
      }
    });

    realm.controlPort.addEventListener('message', messageHandler);
    if (realm.addEventListener) {
      realm.addEventListener('error', errorHandler);
      realm.addEventListener('messageerror', messageErrorHandler);
    }

    const init: RealmInitMsg = {
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
    };
    realm.controlPort.postMessage(init);
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
