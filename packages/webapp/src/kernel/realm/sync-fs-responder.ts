/**
 * Kernel-worker responder for the synchronous-fs bridge.
 *
 * The realm's synchronous XHR is intercepted by the controlling Service
 * Worker, which round-trips the request over the per-session
 * (nonce-named — see `sync-fs-wire.ts`) BroadcastChannel to THIS responder.
 * The responder runs in the kernel worker — co-located with the token registry
 * and every realm's `ctx.fs` — so it can answer from the calling realm's own
 * (ACL + sudo enforced) filesystem via `dispatchSyncFs`, and there is no page
 * hop and no deadlock (the blocked realm worker is a different thread from this
 * one).
 *
 * Wire protocol (see `sync-fs-wire.ts`, the shared contract):
 *   SW → responder:  { type: 'sync-fs-req', id, ...SyncFsRequest }
 *   responder → SW:  { type: 'sync-fs-ack', id }      (posted synchronously)
 *                    { type: 'sync-fs-res', id, ...SyncFsResult }
 *
 * The ack is posted BEFORE the async dispatch so the SW handler can stop its
 * cold-start re-post loop (BroadcastChannel drops messages to a listener that
 * is not yet attached — see `preview-sw-handler.ts`).
 *
 * IDEMPOTENCY: the SW re-posts the same `id` until it *processes* the ack; under
 * load that ack can lag past the re-post interval, so the responder can see the
 * same request more than once. Each op runs AT MOST ONCE: a first-seen `id` is
 * dispatched; a re-post of a known `id` is only re-acked (and, once settled,
 * its cached result re-posted) — never re-dispatched. Without this a re-posted
 * `write` would run twice (double sudo prompt, double mount PUT, and — worst —
 * dispatch #2 clobbering a concurrent writer's newer bytes with stale ones).
 *
 * Per-worker channels + SW fan-out: each kernel worker (one per same-origin
 * leader tab) owns its OWN nonce-named channel, and the controlling SW keeps a
 * channel per live nonce and fans every request out to ALL of them (see
 * `llm-proxy-sw.ts` + `handleSyncFsRequest`). So more than one responder can
 * receive a request; each therefore stays SILENT for a token it does not own —
 * only the owning worker acks + answers. A genuinely unknown / revoked / forged
 * token is answered by nobody and fails closed via the SW handler's timeout
 * (EIO), which is the correct outcome for the abuse path (not the hot path).
 */

import { dispatchSyncFs, type SyncFsResult } from './sync-fs-dispatch.js';
import { resolveSyncFsToken } from './sync-fs-token-registry.js';
import {
  type SyncFsAckMsg,
  type SyncFsReqMsg,
  type SyncFsResMsg,
  syncFsChannelName,
} from './sync-fs-wire.js';

/** How long a settled id's result is retained to answer late re-posts. */
const DEDUPE_TTL_MS = 15_000;

/** Structural subset of `BroadcastChannel` so tests can inject a fake. */
export interface SyncFsChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close?(): void;
}

export interface SyncFsResponderHandle {
  /** Stop answering + release the channel we created (never a caller's). */
  dispose(): void;
}

interface DedupeEntry {
  /** Present once the dispatch has settled — re-posts replay this. */
  result?: SyncFsResult;
  /** Cleanup timer so the map can't grow unbounded across a long session. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Install the sync-fs responder. Production passes `{ nonce }` and a
 * `BroadcastChannel(syncFsChannelName(nonce))` is created + owned here; tests
 * pass `{ channel }` to inject a fake. Exactly one of the two must be given.
 */
export function installSyncFsResponder(
  opts: { nonce?: string; channel?: SyncFsChannelLike } = {}
): SyncFsResponderHandle {
  const owned = opts.channel === undefined;
  if (owned && !opts.nonce) {
    throw new Error('installSyncFsResponder: a nonce (or a test channel) is required');
  }
  const ch: SyncFsChannelLike =
    opts.channel ??
    (new BroadcastChannel(syncFsChannelName(opts.nonce as string)) as unknown as SyncFsChannelLike);

  const post = (msg: SyncFsAckMsg | SyncFsResMsg): void => ch.postMessage(msg);

  // id → dedupe entry. Bounds double-dispatch of re-posted requests.
  const seen = new Map<string, DedupeEntry>();

  const listener = (event: MessageEvent): void => {
    const data = event.data as Partial<SyncFsReqMsg> | undefined;
    if (data?.type !== 'sync-fs-req' || typeof data.id !== 'string') return;
    const req = data as SyncFsReqMsg;
    // Only THIS worker's realms are answerable here. A token we don't own
    // belongs to another same-origin worker (or is forged/revoked) — stay
    // silent so we can't win a race with a spurious EACCES (see header).
    if (!resolveSyncFsToken(req.token)) return;

    const existing = seen.get(req.id);
    if (existing) {
      // Re-post of an in-flight or settled request. Re-ack (so the SW stops
      // retrying) and, if we already have the result, replay it — but NEVER
      // re-run the op.
      post({ type: 'sync-fs-ack', id: req.id });
      if (existing.result) post({ type: 'sync-fs-res', id: req.id, ...existing.result });
      return;
    }

    const entry: DedupeEntry = {};
    seen.set(req.id, entry);
    // Ack synchronously (before the async dispatch) so the SW handler stops
    // re-posting during the cold-start listener race.
    post({ type: 'sync-fs-ack', id: req.id });

    const settle = (result: SyncFsResult): void => {
      entry.result = result;
      // Retain briefly to answer late re-posts, then evict (bounded memory).
      entry.timer = setTimeout(() => seen.delete(req.id), DEDUPE_TTL_MS);
      post({ type: 'sync-fs-res', id: req.id, ...result });
    };
    // dispatchSyncFs is written not to reject, but a future ctx.fs could throw
    // synchronously (e.g. in resolvePath). Catch it and post a terminal errno
    // so the blocked realm worker never waits out the SW handler's full
    // timeout — fail closed, not hang.
    void dispatchSyncFs(req)
      .then(settle)
      .catch((err) =>
        settle({
          ok: false,
          errno: 'EIO',
          message: err instanceof Error ? err.message : String(err),
        })
      );
  };

  ch.addEventListener('message', listener);
  return {
    dispose: () => {
      ch.removeEventListener('message', listener);
      for (const entry of seen.values()) if (entry.timer) clearTimeout(entry.timer);
      seen.clear();
      if (owned) ch.close?.();
    },
  };
}
