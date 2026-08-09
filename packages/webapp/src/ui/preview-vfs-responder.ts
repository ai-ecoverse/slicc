/**
 * `preview-vfs` BroadcastChannel responder — the page-side endpoint
 * the `/preview/*` service worker (`preview-sw.ts`) talks to when it
 * needs file content the SW's own VFS can't satisfy (e.g. mounted
 * directories the SW can't reach).
 *
 * Two installation sites in `main.ts`:
 *   - `mainExtension` — side panel responder.
 *   - `mainStandaloneWorker` — page responder (worker-owned VFS).
 *
 * The reader is held by reference (`getReader()`) so the caller can
 * swap from the page-side `localFs` to a kernel-RPC-backed
 * `RemoteVfsClient` once the worker is up and the `slicc_opfs_vfs`
 * flag is on. The wire contract with `preview-sw.ts` is unchanged —
 * same envelope shape, same `asText` boolean.
 */

import type { LocalVfsClient } from '../kernel/local-vfs-client.js';

/** Panel inbound: preview SW asking for a file. */
export interface PreviewVfsReadRequest {
  type: 'preview-vfs-read';
  /** Correlation id echoed on the matching response. */
  id: string;
  path: string;
  /** `true` → utf-8 string; `false` → binary `Uint8Array`. */
  asText: boolean;
}

/** Panel outbound: response branches mirror the SW's expectations. */
export type PreviewVfsResponse =
  /**
   * Receipt acknowledgement, posted synchronously before the (possibly slow)
   * read starts. Lets `readViaMainPage` stop its cold-start re-post loop so a
   * large read is never issued twice.
   */
  | { type: 'preview-vfs-ack'; id: string }
  /**
   * Dequeue notification: the serialized read pipeline reached this request
   * and its read is starting NOW. Requesters restart their timeout budget on
   * this signal so time spent queued behind a large read (e.g. a multi-hundred-
   * MB model file) does not count against the read's own deadline. Requesters
   * that predate the signal simply never restart — same behavior as before.
   */
  | { type: 'preview-vfs-start'; id: string }
  | { type: 'preview-vfs-response'; id: string; content: string | Uint8Array }
  | { type: 'preview-vfs-response'; id: string; error: string };

/**
 * Structural subset of `BroadcastChannel` so this helper is
 * testable with an in-memory polyfill (`tests/cdp/...`).
 */
export interface PreviewVfsChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface PreviewVfsResponderOptions {
  /**
   * Lookup the current reader at request-time so the caller can
   * swap implementations (e.g. `localFs` → `RemoteVfsClient`) without
   * re-installing the listener.
   */
  getReader: () => LocalVfsClient;
  /** Pre-constructed channel; tests inject the polyfill. */
  channel: PreviewVfsChannelLike;
  /** Optional logger — defaults to silent on ENOENT, error on the rest. */
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
}

export interface PreviewVfsResponderHandle {
  /** Stop listening; the channel is left open for the caller to close. */
  dispose(): void;
}

/**
 * Install the `preview-vfs-read` listener on the supplied channel.
 * Returns a handle whose `dispose()` removes the listener.
 */
export function installPreviewVfsResponder(
  opts: PreviewVfsResponderOptions
): PreviewVfsResponderHandle {
  const { channel, getReader, logger } = opts;

  async function respond(id: string, path: string, asText: boolean): Promise<void> {
    try {
      const reader = getReader();
      // ZenFS' readFile does not throw EISDIR on a directory — it returns
      // the directory entry's bytes — so the preview SW's directory →
      // index.html fallback (which keys off an EISDIR error) never fires.
      // Detect directories with a stat and surface EISDIR explicitly, the
      // same POSIX-contract enforcement shell/vfs-adapter.ts applies for
      // ZenFS. stat() throws ENOENT for missing paths, so the silent-404
      // path below is preserved.
      const stats = await reader.stat(path);
      if (stats.type === 'directory') {
        channel.postMessage({
          type: 'preview-vfs-response',
          id,
          error: `EISDIR: is a directory '${path}'`,
        } satisfies PreviewVfsResponse);
        return;
      }
      const encoding = asText ? 'utf-8' : 'binary';
      const content = await reader.readFile(path, { encoding });
      channel.postMessage({
        type: 'preview-vfs-response',
        id,
        content,
      } satisfies PreviewVfsResponse);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes('ENOENT')) {
        logger?.error('Preview VFS read failed', { path, error: errMsg });
      }
      channel.postMessage({
        type: 'preview-vfs-response',
        id,
        error: errMsg,
      } satisfies PreviewVfsResponse);
    }
  }

  // Reads are SERIALIZED through this per-responder chain. The kernel VFS
  // (ZenFS WebAccess-on-OPFS behind the RemoteVfsClient RPC) is not safe
  // under same-context concurrent reads: overlapping readFile calls can
  // resolve with each other's content. Observed live with a parallel
  // module-graph fetch through the preview SW — every chunk URL of an
  // ipk-installed package came back with the entry file's bytes, so the
  // import linked but failed with a missing-export error. Sequential
  // reads are verified correct; the throughput cost is negligible next
  // to the BroadcastChannel + RPC round trip each read already pays.
  let queue: Promise<void> = Promise.resolve();

  const listener = (event: MessageEvent): void => {
    const data = event.data as PreviewVfsReadRequest | undefined;
    if (data?.type !== 'preview-vfs-read') return;
    const { id, path, asText } = data;
    // Ack on receipt (synchronously, before queueing) so the SW halts its
    // cold-start re-post loop before this (potentially multi-MB) read
    // begins; without it a slow read would be re-requested and duplicated.
    channel.postMessage({ type: 'preview-vfs-ack', id } satisfies PreviewVfsResponse);
    // `respond` never rejects (its body is fully try/caught), but guard the
    // chain anyway — a poisoned queue would silently starve every later read.
    const dequeue = (): Promise<void> => {
      // Signal dequeue-time so the requester's timeout measures the read
      // itself, not its wait in the backlog.
      channel.postMessage({ type: 'preview-vfs-start', id } satisfies PreviewVfsResponse);
      return respond(id, path, asText);
    };
    queue = queue.then(dequeue, dequeue);
  };
  channel.addEventListener('message', listener);
  return {
    dispose: () => channel.removeEventListener('message', listener),
  };
}
