/**
 * `RemoteVfsClient` — page-side `LocalVfsClient` whose backing store is
 * the worker-side `VfsRpcHost` over a shared `KernelTransport`.
 *
 * With `slicc_opfs_vfs === 'opfs'`, the page can no longer reach
 * OPFS directly, so panel-side file-browser / memory reads route
 * through the kernel transport. The wire shape is defined in
 * `kernel/messages.ts` (`VfsReadRequestMsg` /
 * `VfsReadResultMsg`); the host-side responder is `VfsRpcHost`.
 *
 * Per-request lifecycle (mirror of `VfsRpcHost`):
 *   readDir(path)            → `vfs-read-dir`  → `vfs-read-dir-result`
 *   readFile(path, opts?)    → `vfs-read-file` → `vfs-read-file-result`
 *   stat(path)               → `vfs-stat`      → `vfs-stat-result`
 *   watch(basePaths, cb)     → `vfs-watch`     → `vfs-watch-result` ack,
 *                              then a `vfs-watch-event` push per change
 *                              batch until the returned unsubscribe sends
 *                              `vfs-unwatch` (#2409).
 *
 * Failure-branch responses are translated back into `FsError(code, …)`
 * so callers see the same throw shape they would from `VirtualFS`.
 *
 * The client subscribes to inbound envelopes filtered by
 * `source === 'offscreen'` and demultiplexes by `requestId`. Multiple
 * concurrent requests share the same transport — the bridge, terminal
 * host, and VFS host all coexist on a single port.
 */

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RemoteVfsClientOptions {
  /**
   * Same kernel transport the panel-side `OffscreenClient` and
   * `TerminalSessionClient` use. Subscribing via `onMessage` adds
   * another listener on the shared wire; the chrome.runtime /
   * MessageChannel adapters both support multiple listeners.
   */
  transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;
  /**
   * Optional id factory. Defaults to a counter + random suffix; tests
   * can inject a deterministic generator.
   */
  generateRequestId?: () => string;
  /**
   * Per-request timeout in ms. Defaults to 30s. A request that gets no
   * matching response within this window rejects with `FsError('EIO',
   * …)` instead of hanging forever. This matters because the worker's
   * `VfsRpcHost` only attaches its listener at the tail of boot — a
   * read issued before the host is live (or a response otherwise lost
   * on the shared wire) would never be answered, silently stranding
   * the caller. Pass `0` (or negative) to disable the timeout.
   */
  requestTimeoutMs?: number;
  /**
   * Optional logger — defaults to `console`. Override in tests to
   * silence expected warnings.
   */
  logger?: {
    warn(msg: string, ...rest: unknown[]): void;
    debug?(msg: string, ...rest: unknown[]): void;
  };
}

export interface RemoteVfsClientHandle extends LocalVfsClient {
  /**
   * Always present here (unlike the optional `LocalVfsClient.watch`): the
   * host either has a watcher or fails the ack, and either way the caller
   * gets an answer rather than a missing method.
   */
  watch(
    basePaths: readonly string[],
    callback: (events: FsChangeEvent[]) => void
  ): Promise<() => void>;
  /** Tear down the transport subscription. Pending requests reject. */
  dispose(): void;
}

/**
 * Construct a `RemoteVfsClient`. Returns a `LocalVfsClient` with a
 * `dispose()` method so callers can release the transport subscription
 * on panel teardown (HMR, popout-detach, etc.).
 */
export function createRemoteVfsClient(opts: RemoteVfsClientOptions): RemoteVfsClientHandle {
  return new RemoteVfsClient(opts);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type ResultMsg = VfsReadDirResultMsg | VfsReadFileResultMsg | VfsStatResultMsg;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  /** Which result-type we expect — guards against a stray cross-route reply. */
  expect: ResultMsg['type'];
  /** Path argument, echoed onto a synthesised error if the responder dies. */
  path: string;
  /** Timeout handle, cleared when the response lands (or on dispose). */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Default per-request timeout (ms). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Request-id namespace for the read client. Disjoint from the writable
 * client's `vfs-w-` prefix (note: NOT a prefix of it) so the two clients
 * — which share one transport and both match `vfs-read-*-result` envelopes
 * — can each tell its own responses from a sibling's. See `handleResult`.
 */
const READ_REQUEST_ID_PREFIX = 'vfs-r-';

/**
 * Subscription-id namespace for `watch`. Disjoint from the request-id
 * namespaces above — watch envelopes carry `subscriptionId`, not
 * `requestId`, so they can never collide, but a distinct prefix keeps
 * a logged id self-describing.
 */
const WATCH_SUBSCRIPTION_ID_PREFIX = 'vfs-sub-';

/** How long to wait for the `vfs-watch` ack before giving up (ms). */
const WATCH_ACK_TIMEOUT_MS = 10_000;

interface PendingWatch {
  callback: (events: FsChangeEvent[]) => void;
}

interface PendingWatchAck {
  settle: (result: VfsWatchResultMsg) => void;
  /** Rejects the caller on dispose, so a teardown mid-subscribe fails fast. */
  fail: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RemoteVfsClient implements RemoteVfsClientHandle {
  private readonly transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;
  private readonly log: NonNullable<RemoteVfsClientOptions['logger']>;
  private readonly genId: () => string;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  /** Live `watch` subscriptions, keyed by subscription id. */
  private readonly watches = new Map<string, PendingWatch>();
  /** Acks still in flight, keyed the same way. Settled on dispose. */
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

  // -------------------------------------------------------------------------
  // LocalVfsClient surface
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

  /**
   * Subscribe to VFS changes under `basePaths`. Resolves once the worker
   * acks, to an unsubscribe that drops the worker-side registration too —
   * so an unsubscribed panel costs the worker nothing, not just the page.
   *
   * Rejects when the host has no watcher wired (`ENOSYS`) or the ack never
   * lands, which is the caller's cue to fall back to polling.
   */
  async watch(
    basePaths: readonly string[],
    callback: (events: FsChangeEvent[]) => void
  ): Promise<() => void> {
    this.watchCounter = (this.watchCounter + 1) >>> 0;
    const rand = Math.random().toString(36).slice(2, 8);
    const subscriptionId = `${WATCH_SUBSCRIPTION_ID_PREFIX}${this.watchCounter.toString(36)}-${rand}`;
    // Registered BEFORE the ack: the worker may push a batch between
    // sending the ack and the page processing it, and a dropped first
    // batch is exactly the change the caller subscribed to see.
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
    // Drop subscriptions on the worker side too — a disposed client whose
    // registrations survive would have the host pushing events at nobody
    // for the rest of the session.
    for (const [subscriptionId] of this.watches) {
      const req: VfsUnwatchRequestMsg = { type: 'vfs-unwatch', subscriptionId };
      try {
        this.transport.send(req as PanelToOffscreenMessage);
      } catch {
        // Transport already gone — nothing to release.
      }
    }
    this.watches.clear();
    // Settle in-flight subscribes rather than dropping their resolvers: an
    // abandoned ack promise would leave the caller hanging for the full
    // 10 s ack timeout AFTER teardown, and then reject into a dead panel.
    for (const [, ack] of [...this.watchAcks]) {
      ack.fail(new FsError('EBADF', 'RemoteVfsClient disposed'));
    }
    this.watchAcks.clear();
    // Reject any in-flight requests so callers don't hang forever after
    // teardown (e.g. panel-detach mid-readDir refresh).
    for (const [, p] of this.pending) {
      if (p.timer !== null) clearTimeout(p.timer);
      p.reject(new FsError('EBADF', 'RemoteVfsClient disposed', p.path));
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
    payload: VfsReadDirRequestMsg | VfsReadFileRequestMsg | VfsStatRequestMsg
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (this.requestTimeoutMs > 0) {
        timer = setTimeout(() => {
          // No matching response arrived in time — the responder is
          // either not up yet or the reply was lost on the shared wire.
          // Reject so the caller fails fast instead of hanging forever.
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
      // No pending entry. In standalone the page runs this reader AND a
      // sibling `RemoteWritableVfsClient` on the SAME transport, and both
      // match `vfs-read-*-result` envelopes — so a response addressed to the
      // sibling (id prefix `vfs-w-`) routinely lands here. That is expected;
      // ignore it silently. Logging a "drop" per sibling read flooded the
      // console and the page→node-server log relay under tray-leader load.
      // Only an id in OUR namespace that has no pending entry is a genuine
      // anomaly (duplicate/late host reply); surface that at debug level.
      if (msg.requestId.startsWith(READ_REQUEST_ID_PREFIX)) {
        this.log.debug?.('[remote-vfs-client] drop unmatched response', {
          type: msg.type,
          requestId: msg.requestId,
        });
      }
      return;
    }
    // A response landed — cancel the timeout before settling.
    if (pending.timer !== null) clearTimeout(pending.timer);
    if (pending.expect !== msg.type) {
      // Type-discriminator mismatch — shouldn't happen with the typed
      // host, but guard against a future cross-route bug.
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
  return t === 'vfs-read-dir-result' || t === 'vfs-read-file-result' || t === 'vfs-stat-result';
}

function isVfsWatchPush(payload: { type?: string }): boolean {
  return payload.type === 'vfs-watch-result' || payload.type === 'vfs-watch-event';
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
    'ENOSYS',
    'EIO',
  ];
  const narrowed: FsErrorCode = known.includes(code as FsErrorCode) ? (code as FsErrorCode) : 'EIO';
  return new FsError(narrowed, message, path);
}
