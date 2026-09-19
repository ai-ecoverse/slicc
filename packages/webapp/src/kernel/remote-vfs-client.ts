import type { ReadDirOptions } from '../fs/mount/backend.js';
import type { DirEntry, FsChangeEvent, ReadFileOptions, Stats } from '../fs/types.js';
import { FsError, type FsErrorCode } from '../fs/types.js';
import type { LocalVfsClient } from './local-vfs-client.js';
import type {
  ExtensionMessage,
  PanelToOffscreenMessage,
  VfsReadDirRequestMsg,
  VfsReadDirResultMsg,
  VfsReadFileRequestMsg,
  VfsReadFileResultMsg,
  VfsStatRequestMsg,
  VfsStatResultMsg,
  VfsUnwatchRequestMsg,
  VfsWatchEventMsg,
  VfsWatchRequestMsg,
  VfsWatchResultMsg,
} from './messages.js';
import type { KernelTransport } from './types.js';

export interface RemoteVfsClientOptions {
  transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;

  generateRequestId?: () => string;

  requestTimeoutMs?: number;

  logger?: {
    warn(msg: string, ...rest: unknown[]): void;
    debug?(msg: string, ...rest: unknown[]): void;
  };
}

export interface RemoteVfsClientHandle extends LocalVfsClient {
  watch(
    basePaths: readonly string[],
    callback: (events: FsChangeEvent[]) => void
  ): Promise<() => void>;

  readFileRange(path: string, start: number, end: number): Promise<Uint8Array>;

  dispose(): void;
}

export function createRemoteVfsClient(opts: RemoteVfsClientOptions): RemoteVfsClientHandle {
  return new RemoteVfsClient(opts);
}

type ResultMsg = VfsReadDirResultMsg | VfsReadFileResultMsg | VfsStatResultMsg;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;

  expect: ResultMsg['type'];

  path: string;

  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const READ_REQUEST_ID_PREFIX = 'vfs-r-';

const WATCH_SUBSCRIPTION_ID_PREFIX = 'vfs-sub-';

const WATCH_ACK_TIMEOUT_MS = 10_000;

interface PendingWatch {
  callback: (events: FsChangeEvent[]) => void;
}

interface PendingWatchAck {
  settle: (result: VfsWatchResultMsg) => void;

  fail: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RemoteVfsClient implements RemoteVfsClientHandle {
  private readonly transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;
  private readonly log: NonNullable<RemoteVfsClientOptions['logger']>;
  private readonly genId: () => string;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  private readonly watches = new Map<string, PendingWatch>();

  private readonly watchAcks = new Map<string, PendingWatchAck>();
  private unsubscribe: (() => void) | null = null;
  private counter = 0;
  private watchCounter = 0;

  constructor(opts: RemoteVfsClientOptions) {
    this.transport = opts.transport;
    this.log = opts.logger ?? console;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.genId =
      opts.generateRequestId ??
      (() => {
        this.counter = (this.counter + 1) >>> 0;
        const rand = Math.random().toString(36).slice(2, 8);
        return `${READ_REQUEST_ID_PREFIX}${this.counter.toString(36)}-${rand}`;
      });
    this.unsubscribe = this.transport.onMessage((envelope) => {
      if (!isExtensionEnvelope(envelope)) return;
      if (envelope.source !== 'offscreen') return;
      const payload = envelope.payload as { type?: string; requestId?: string };
      if (isVfsWatchPush(payload)) {
        this.handleWatchPush(payload as unknown as VfsWatchResultMsg | VfsWatchEventMsg);
        return;
      }
      if (!isVfsResult(payload)) return;
      this.handleResult(payload as ResultMsg);
    });
  }

  readDir(path: string, opts?: ReadDirOptions): Promise<DirEntry[]> {
    const requestId = this.genId();
    const req: VfsReadDirRequestMsg = {
      type: 'vfs-read-dir',
      requestId,
      path,
      ...(opts?.includeStats === true ? { includeStats: true as const } : {}),
    };
    return this.request<DirEntry[]>(requestId, 'vfs-read-dir-result', path, req);
  }

  readFile(path: string, options?: ReadFileOptions): Promise<string | Uint8Array> {
    const requestId = this.genId();
    const encoding = options?.encoding ?? 'utf-8';
    const req: VfsReadFileRequestMsg = { type: 'vfs-read-file', requestId, path, encoding };
    return this.request<string | Uint8Array>(requestId, 'vfs-read-file-result', path, req);
  }

  readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const requestId = this.genId();
    const req: VfsReadFileRequestMsg = {
      type: 'vfs-read-file',
      requestId,
      path,
      encoding: 'binary',
      start,
      end,
    };
    return this.request<Uint8Array>(requestId, 'vfs-read-file-result', path, req);
  }

  stat(path: string): Promise<Stats> {
    const requestId = this.genId();
    const req: VfsStatRequestMsg = { type: 'vfs-stat', requestId, path };
    return this.request<Stats>(requestId, 'vfs-stat-result', path, req);
  }

  async watch(
    basePaths: readonly string[],
    callback: (events: FsChangeEvent[]) => void
  ): Promise<() => void> {
    this.watchCounter = (this.watchCounter + 1) >>> 0;
    const rand = Math.random().toString(36).slice(2, 8);
    const subscriptionId = `${WATCH_SUBSCRIPTION_ID_PREFIX}${this.watchCounter.toString(36)}-${rand}`;

    this.watches.set(subscriptionId, { callback });
    const unsubscribe = (): void => {
      if (!this.watches.delete(subscriptionId)) return;
      const req: VfsUnwatchRequestMsg = { type: 'vfs-unwatch', subscriptionId };
      try {
        this.transport.send(req as PanelToOffscreenMessage);
      } catch (err) {
        this.log.debug?.('[remote-vfs-client] unwatch send failed', err);
      }
    };
    const ack = new Promise<VfsWatchResultMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.watchAcks.delete(subscriptionId);
        reject(new FsError('EIO', `vfs-watch ack timed out after ${WATCH_ACK_TIMEOUT_MS}ms`));
      }, WATCH_ACK_TIMEOUT_MS);
      this.watchAcks.set(subscriptionId, {
        settle: (result) => {
          clearTimeout(timer);
          this.watchAcks.delete(subscriptionId);
          resolve(result);
        },
        fail: (err) => {
          clearTimeout(timer);
          this.watchAcks.delete(subscriptionId);
          reject(err);
        },
        timer,
      });
    });
    const req: VfsWatchRequestMsg = {
      type: 'vfs-watch',
      subscriptionId,
      basePaths: [...basePaths],
    };
    try {
      this.transport.send(req as PanelToOffscreenMessage);
    } catch (err) {
      this.watches.delete(subscriptionId);
      this.watchAcks.delete(subscriptionId);
      throw err;
    }
    let result: VfsWatchResultMsg;
    try {
      result = await ack;
    } catch (err) {
      this.watches.delete(subscriptionId);
      throw err;
    }
    if (result.ok === false) {
      this.watches.delete(subscriptionId);
      throw toFsError(result.error.code, result.error.message, result.error.path);
    }
    return unsubscribe;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const [subscriptionId] of this.watches) {
      const req: VfsUnwatchRequestMsg = { type: 'vfs-unwatch', subscriptionId };
      try {
        this.transport.send(req as PanelToOffscreenMessage);
      } catch {}
    }
    this.watches.clear();

    for (const [, ack] of [...this.watchAcks]) {
      ack.fail(new FsError('EBADF', 'RemoteVfsClient disposed'));
    }
    this.watchAcks.clear();

    for (const [, p] of this.pending) {
      if (p.timer !== null) clearTimeout(p.timer);
      p.reject(new FsError('EBADF', 'RemoteVfsClient disposed', p.path));
    }
    this.pending.clear();
  }

  private request<T>(
    requestId: string,
    expect: ResultMsg['type'],
    path: string,
    payload: VfsReadDirRequestMsg | VfsReadFileRequestMsg | VfsStatRequestMsg
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (this.requestTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          reject(
            new FsError(
              'EIO',
              `vfs-rpc request timed out after ${this.requestTimeoutMs}ms (${expect})`,
              path
            )
          );
        }, this.requestTimeoutMs);
      }
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        expect,
        path,
        timer,
      });
      try {
        this.transport.send(payload as PanelToOffscreenMessage);
      } catch (err) {
        this.pending.delete(requestId);
        if (timer !== null) clearTimeout(timer);
        reject(err);
      }
    });
  }

  private handleWatchPush(msg: VfsWatchResultMsg | VfsWatchEventMsg): void {
    if (msg.type === 'vfs-watch-result') {
      this.watchAcks.get(msg.subscriptionId)?.settle(msg);
      return;
    }
    const sub = this.watches.get(msg.subscriptionId);
    if (!sub) return;
    sub.callback(msg.events as FsChangeEvent[]);
  }

  private handleResult(msg: ResultMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending) {
      if (msg.requestId.startsWith(READ_REQUEST_ID_PREFIX)) {
        this.log.debug?.('[remote-vfs-client] drop unmatched response', {
          type: msg.type,
          requestId: msg.requestId,
        });
      }
      return;
    }

    if (pending.timer !== null) clearTimeout(pending.timer);
    if (pending.expect !== msg.type) {
      this.pending.delete(msg.requestId);
      pending.reject(
        new FsError('EIO', `vfs-rpc response type mismatch (got ${msg.type})`, pending.path)
      );
      return;
    }
    this.pending.delete(msg.requestId);
    if (msg.ok === false) {
      pending.reject(toFsError(msg.error.code, msg.error.message, msg.error.path ?? pending.path));
      return;
    }
    switch (msg.type) {
      case 'vfs-read-dir-result':
        pending.resolve(msg.entries as DirEntry[]);
        return;
      case 'vfs-read-file-result':
        pending.resolve(msg.data);
        return;
      case 'vfs-stat-result':
        pending.resolve(msg.stats as Stats);
        return;
    }
  }
}

function isExtensionEnvelope(value: unknown): value is ExtensionMessage {
  return typeof value === 'object' && value !== null && 'source' in value && 'payload' in value;
}

function isVfsResult(payload: { type?: string; requestId?: string }): boolean {
  if (typeof payload.requestId !== 'string') return false;
  const t = payload.type;
  return t === 'vfs-read-dir-result' || t === 'vfs-read-file-result' || t === 'vfs-stat-result';
}

function isVfsWatchPush(payload: { type?: string }): boolean {
  return payload.type === 'vfs-watch-result' || payload.type === 'vfs-watch-event';
}

function toFsError(code: string, message: string, path: string | undefined): FsError {
  const known: FsErrorCode[] = [
    'ENOENT',
    'EEXIST',
    'ENOTDIR',
    'EISDIR',
    'ENOTEMPTY',
    'EINVAL',
    'EACCES',
    'ELOOP',
    'EBUSY',
    'EFBIG',
    'EBADF',
    'ENOSYS',
    'EOPNOTSUPP',
    'EXDEV',
    'EIO',
  ];
  const narrowed: FsErrorCode = known.includes(code as FsErrorCode) ? (code as FsErrorCode) : 'EIO';
  return new FsError(narrowed, message, path);
}
