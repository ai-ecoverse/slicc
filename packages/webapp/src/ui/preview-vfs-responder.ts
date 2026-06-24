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
  const listener = (event: MessageEvent): void => {
    const data = event.data as PreviewVfsReadRequest | undefined;
    if (data?.type !== 'preview-vfs-read') return;
    const { id, path, asText } = data;
    // Ack on receipt so the SW halts its cold-start re-post loop before this
    // (potentially multi-MB) read begins; without it a slow read would be
    // re-requested and duplicated.
    channel.postMessage({ type: 'preview-vfs-ack', id } satisfies PreviewVfsResponse);
    void (async () => {
      try {
        const encoding = asText ? 'utf-8' : 'binary';
        const content = await getReader().readFile(path, { encoding });
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
    })();
  };
  channel.addEventListener('message', listener);
  return {
    dispose: () => channel.removeEventListener('message', listener),
  };
}
