import type { ReadDirOptions } from '../fs/mount/backend.js';
import type {
  DirEntry,
  FileContent,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
  WriteFileOptions,
} from '../fs/types.js';
import { FsError, type FsErrorCode } from '../fs/types.js';
import type { LocalVfsClient } from './local-vfs-client.js';
import type {
  ExtensionMessage,
  PanelToOffscreenMessage,
  VfsFlushRequestMsg,
  VfsFlushResultMsg,
  VfsListMountPointsRequestMsg,
  VfsListMountPointsResultMsg,
  VfsMkdirRequestMsg,
  VfsMkdirResultMsg,
  VfsMountPointEnvelope,
  VfsReadDirRequestMsg,
  VfsReadDirResultMsg,
  VfsReadFileRequestMsg,
  VfsReadFileResultMsg,
  VfsRmRequestMsg,
  VfsRmResultMsg,
  VfsStatRequestMsg,
  VfsStatResultMsg,
  VfsWriteFileRequestMsg,
  VfsWriteFileResultMsg,
} from './messages.js';
import type { KernelTransport } from './types.js';

export interface WritableVfsBackend {
  writeFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  flush(): Promise<void>;

  listMountPoints?(): VfsMountPointEnvelope[] | Promise<VfsMountPointEnvelope[]>;
}

export interface WritableVfsClient extends LocalVfsClient, WritableVfsBackend {
  listMountPoints(): VfsMountPointEnvelope[] | Promise<VfsMountPointEnvelope[]>;
}

export interface RemoteWritableVfsClientOptions {
  transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;

  generateRequestId?: () => string;

  logger?: {
    warn(msg: string, ...rest: unknown[]): void;
    debug?(msg: string, ...rest: unknown[]): void;
  };
}

export interface RemoteWritableVfsClientHandle extends WritableVfsClient {
  dispose(): void;
}

export function createRemoteWritableVfsClient(
  opts: RemoteWritableVfsClientOptions
): RemoteWritableVfsClientHandle {
  return new RemoteWritableVfsClient(opts);
}

type ResultMsg =
  | VfsReadDirResultMsg
  | VfsReadFileResultMsg
  | VfsStatResultMsg
  | VfsWriteFileResultMsg
  | VfsMkdirResultMsg
  | VfsRmResultMsg
  | VfsFlushResultMsg
  | VfsListMountPointsResultMsg;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;

  expect: ResultMsg['type'];

  path: string;
}

const WRITE_REQUEST_ID_PREFIX = 'vfs-w-';

class RemoteWritableVfsClient implements RemoteWritableVfsClientHandle {
  private readonly transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;
  private readonly log: NonNullable<RemoteWritableVfsClientOptions['logger']>;
  private readonly genId: () => string;
  private readonly pending = new Map<string, PendingRequest>();
  private unsubscribe: (() => void) | null = null;
  private counter = 0;

  constructor(opts: RemoteWritableVfsClientOptions) {
    this.transport = opts.transport;
    this.log = opts.logger ?? console;
    this.genId =
      opts.generateRequestId ??
      (() => {
        this.counter = (this.counter + 1) >>> 0;
        const rand = Math.random().toString(36).slice(2, 8);
        return `${WRITE_REQUEST_ID_PREFIX}${this.counter.toString(36)}-${rand}`;
      });
    this.unsubscribe = this.transport.onMessage((envelope) => {
      if (!isExtensionEnvelope(envelope)) return;
      if (envelope.source !== 'offscreen') return;
      const payload = envelope.payload as { type?: string; requestId?: string };
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

  writeFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void> {
    const requestId = this.genId();
    const recursive = options?.recursive;
    if (content instanceof Uint8Array) {
      const req: VfsWriteFileRequestMsg = {
        type: 'vfs-write-file',
        requestId,
        path,
        encoding: 'binary',
        data: content,
        ...(recursive === undefined ? {} : { recursive }),
      };

      const buf = content.buffer;
      const transfer =
        typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer
          ? [buf as Transferable]
          : undefined;
      return this.request<void>(requestId, 'vfs-write-file-result', path, req, transfer);
    }
    if (typeof content !== 'string') {
      return Promise.reject(
        new FsError('EINVAL', 'writeFile content must be string or Uint8Array', path)
      );
    }
    const req: VfsWriteFileRequestMsg = {
      type: 'vfs-write-file',
      requestId,
      path,
      encoding: 'utf-8',
      data: content,
      ...(recursive === undefined ? {} : { recursive }),
    };
    return this.request<void>(requestId, 'vfs-write-file-result', path, req);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const requestId = this.genId();
    const recursive = options?.recursive;
    const req: VfsMkdirRequestMsg = {
      type: 'vfs-mkdir',
      requestId,
      path,
      ...(recursive === undefined ? {} : { recursive }),
    };
    return this.request<void>(requestId, 'vfs-mkdir-result', path, req);
  }

  rm(path: string, options?: RmOptions): Promise<void> {
    const requestId = this.genId();
    const recursive = options?.recursive;
    const req: VfsRmRequestMsg = {
      type: 'vfs-rm',
      requestId,
      path,
      ...(recursive === undefined ? {} : { recursive }),
    };
    return this.request<void>(requestId, 'vfs-rm-result', path, req);
  }

  flush(): Promise<void> {
    const requestId = this.genId();
    const req: VfsFlushRequestMsg = { type: 'vfs-flush', requestId };
    return this.request<void>(requestId, 'vfs-flush-result', '', req);
  }

  listMountPoints(): Promise<VfsMountPointEnvelope[]> {
    const requestId = this.genId();
    const req: VfsListMountPointsRequestMsg = { type: 'vfs-list-mount-points', requestId };
    return this.request<VfsMountPointEnvelope[]>(
      requestId,
      'vfs-list-mount-points-result',
      '',
      req
    );
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const [, p] of this.pending) {
      p.reject(new FsError('EBADF', 'RemoteWritableVfsClient disposed', p.path));
    }
    this.pending.clear();
  }

  private request<T>(
    requestId: string,
    expect: ResultMsg['type'],
    path: string,
    payload:
      | VfsReadDirRequestMsg
      | VfsReadFileRequestMsg
      | VfsStatRequestMsg
      | VfsWriteFileRequestMsg
      | VfsMkdirRequestMsg
      | VfsRmRequestMsg
      | VfsFlushRequestMsg
      | VfsListMountPointsRequestMsg,
    transfer?: Transferable[]
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        expect,
        path,
      });
      try {
        this.transport.send(payload as PanelToOffscreenMessage, transfer);
      } catch (err) {
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  private handleResult(msg: ResultMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending) {
      if (msg.requestId.startsWith(WRITE_REQUEST_ID_PREFIX)) {
        this.log.debug?.('[remote-writable-vfs-client] drop unmatched response', {
          type: msg.type,
          requestId: msg.requestId,
        });
      }
      return;
    }
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
      case 'vfs-list-mount-points-result':
        pending.resolve(msg.mountPoints);
        return;
      case 'vfs-write-file-result':
      case 'vfs-mkdir-result':
      case 'vfs-rm-result':
      case 'vfs-flush-result':
        pending.resolve(undefined);
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
  return (
    t === 'vfs-read-dir-result' ||
    t === 'vfs-read-file-result' ||
    t === 'vfs-stat-result' ||
    t === 'vfs-write-file-result' ||
    t === 'vfs-mkdir-result' ||
    t === 'vfs-rm-result' ||
    t === 'vfs-flush-result' ||
    t === 'vfs-list-mount-points-result'
  );
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
