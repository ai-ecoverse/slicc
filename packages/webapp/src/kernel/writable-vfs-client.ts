/**
 * `WritableVfsClient` — page-side `LocalVfsClient` extension that adds
 * the writable subset of `VirtualFS` (`writeFile`, `mkdir`, `rm`,
 * `flush`) backed by the worker-side `VfsRpcHost` over a shared
 * `KernelTransport`.
 *
 * With `slicc_opfs_vfs === 'opfs'`, the page can no longer reach
 * OPFS directly, so page-side writers (e.g. `session-freezer.ts`)
 * need to route through the kernel transport. The wire shape is
 * defined in `kernel/messages.ts`
 * (`VfsWriteRequestMsg` / `VfsWriteResultMsg`); the host-side
 * responder is `VfsRpcHost` with `writableClient` wired.
 *
 * Per-request lifecycle (mirror of `VfsRpcHost`):
 *   readDir(path)                  → `vfs-read-dir`   → `vfs-read-dir-result`
 *   readFile(path, opts?)          → `vfs-read-file`  → `vfs-read-file-result`
 *   stat(path)                     → `vfs-stat`       → `vfs-stat-result`
 *   writeFile(path, data, opts?)   → `vfs-write-file` → `vfs-write-file-result`
 *                                    Binary writes carry the underlying
 *                                    `ArrayBuffer` in the transport's
 *                                    transfer list, so the
 *                                    `MessageChannel` adapter moves
 *                                    ownership (no copy) on standalone.
 *                                    chrome.runtime ignores the
 *                                    transfer list and copies instead.
 *   mkdir(path, opts?)             → `vfs-mkdir`      → `vfs-mkdir-result`
 *   rm(path, opts?)                → `vfs-rm`         → `vfs-rm-result`
 *   flush()                        → `vfs-flush`      → `vfs-flush-result`
 *   listMountPoints()              → `vfs-list-mount-points`
 *                                    → `vfs-list-mount-points-result`
 *
 * Failure-branch responses are translated back into `FsError(code, …)`
 * so callers see the same throw shape they would from `VirtualFS`.
 *
 * The client subscribes to inbound envelopes filtered by
 * `source === 'offscreen'` and demultiplexes by `requestId`. Multiple
 * concurrent requests share the same transport — the bridge, terminal
 * host, read-side `RemoteVfsClient`, and this writable client all
 * coexist on a single port.
 */

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Worker-side writable VFS backend the host dispatches to. Structurally
 * a subset of `VirtualFS` — `host.sharedFs` satisfies it for free.
 * Defined here (not in `local-vfs-client.ts`) because the read-only
 * facade comment in that file calls out that future writes route
 * through `kernelClient.fs.*` RPCs; this interface is that surface.
 */
export interface WritableVfsBackend {
  writeFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  flush(): Promise<void>;
  /** Optional on generic writers; the canonical `VirtualFS` implements it synchronously. */
  listMountPoints?(): VfsMountPointEnvelope[] | Promise<VfsMountPointEnvelope[]>;
}

/**
 * `LocalVfsClient` plus the writable subset of `VirtualFS`. Page-side
 * callers that need to mutate the VFS over the RPC wire consume this
 * interface; read-only callers can keep typing against
 * `LocalVfsClient`.
 */
export interface WritableVfsClient extends LocalVfsClient, WritableVfsBackend {
  listMountPoints(): VfsMountPointEnvelope[] | Promise<VfsMountPointEnvelope[]>;
}

export interface RemoteWritableVfsClientOptions {
  /**
   * Same kernel transport the panel-side `OffscreenClient`,
   * `RemoteVfsClient`, and `TerminalSessionClient` use. Subscribing
   * via `onMessage` adds another listener on the shared wire; the
   * chrome.runtime / MessageChannel adapters both support multiple
   * listeners.
   */
  transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;
  /**
   * Optional id factory. Defaults to a counter + random suffix; tests
   * can inject a deterministic generator.
   */
  generateRequestId?: () => string;
  /**
   * Optional logger — defaults to `console`. Override in tests to
   * silence expected warnings.
   */
  logger?: {
    warn(msg: string, ...rest: unknown[]): void;
    debug?(msg: string, ...rest: unknown[]): void;
  };
}

export interface RemoteWritableVfsClientHandle extends WritableVfsClient {
  /** Tear down the transport subscription. Pending requests reject. */
  dispose(): void;
}

/**
 * Construct a `RemoteWritableVfsClient`. Returns a `WritableVfsClient`
 * with a `dispose()` method so callers can release the transport
 * subscription on panel teardown (HMR, popout-detach, etc.).
 */
export function createRemoteWritableVfsClient(
  opts: RemoteWritableVfsClientOptions
): RemoteWritableVfsClientHandle {
  return new RemoteWritableVfsClient(opts);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

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
  /** Which result-type we expect — guards against a stray cross-route reply. */
  expect: ResultMsg['type'];
  /** Path argument, echoed onto a synthesised error if the responder dies. */
  path: string;
}

/**
 * Request-id namespace for the writable client. Disjoint from the read
 * client's `vfs-r-` prefix so the two clients — which share one transport
 * and both match `vfs-read-*-result` envelopes — can each tell its own
 * responses from a sibling's. See `handleResult`.
 */
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

  // -------------------------------------------------------------------------
  // Read surface (LocalVfsClient)
  // -------------------------------------------------------------------------

  readDir(path: string): Promise<DirEntry[]> {
    const requestId = this.genId();
    const req: VfsReadDirRequestMsg = { type: 'vfs-read-dir', requestId, path };
    return this.request<DirEntry[]>(requestId, 'vfs-read-dir-result', path, req);
  }

  readFile(path: string, options?: ReadFileOptions): Promise<string | Uint8Array> {
    const requestId = this.genId();
    const encoding = options?.encoding ?? 'utf-8';
    const req: VfsReadFileRequestMsg = { type: 'vfs-read-file', requestId, path, encoding };
    return this.request<string | Uint8Array>(requestId, 'vfs-read-file-result', path, req);
  }

  stat(path: string): Promise<Stats> {
    const requestId = this.genId();
    const req: VfsStatRequestMsg = { type: 'vfs-stat', requestId, path };
    return this.request<Stats>(requestId, 'vfs-stat-result', path, req);
  }

  // -------------------------------------------------------------------------
  // Write surface (WritableVfsBackend)
  // -------------------------------------------------------------------------

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
      // Transfer the backing buffer so the MessageChannel adapter moves
      // ownership (no copy) on standalone. The chrome.runtime adapter
      // silently ignores the transfer list. Guard against SAB-backed
      // views (`buffer` would not be a Transferable).
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
    // Reject any in-flight requests so callers don't hang forever after
    // teardown (e.g. panel-detach mid-write).
    for (const [, p] of this.pending) {
      p.reject(new FsError('EBADF', 'RemoteWritableVfsClient disposed', p.path));
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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
      // No pending entry. In standalone the page runs this writable client
      // AND a sibling read-only `RemoteVfsClient` on the SAME transport, and
      // both match `vfs-read-*-result` envelopes — so a response addressed to
      // the sibling (id prefix `vfs-r-`) routinely lands here. That is
      // expected; ignore it silently. Logging a "drop" per sibling read
      // flooded the console and the page→node-server log relay under
      // tray-leader load. Only an id in OUR namespace that has no pending
      // entry is a genuine anomaly (duplicate/late host reply).
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
        // `data` is already the right shape per the `encoding`
        // discriminator on the success branch.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  // The wire carries a string; narrow to the typed `FsErrorCode` set
  // and fall back to `EIO` for any code the page doesn't know.
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
    'EIO',
  ];
  const narrowed: FsErrorCode = known.includes(code as FsErrorCode) ? (code as FsErrorCode) : 'EIO';
  return new FsError(narrowed, message, path);
}
