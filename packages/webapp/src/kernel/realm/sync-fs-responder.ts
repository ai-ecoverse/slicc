/**
 * Kernel-worker responder for the synchronous-fs bridge.
 *
 * The realm's synchronous XHR is intercepted by the controlling Service
 * Worker, which round-trips the request over the `slicc-sync-fs`
 * BroadcastChannel to THIS responder. The responder runs in the kernel worker
 * — co-located with the token registry and every realm's `ctx.fs` — so it can
 * answer from the calling realm's own (ACL + sudo enforced) filesystem via
 * `dispatchSyncFs`, and there is no page hop and no deadlock (the blocked realm
 * worker is a different thread from this one).
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
 * Origin-scoping: the channel is origin-scoped, so if two kernel workers share
 * an origin (e.g. a transient duplicate leader tab) BOTH receive every request.
 * A responder therefore stays SILENT for a token it does not own — only the
 * owning worker answers. A genuinely unknown / revoked / forged token is
 * answered by nobody and fails closed via the SW handler's timeout (EIO), which
 * is the correct outcome for the abuse path (not the hot path).
 */

import { dispatchSyncFs } from './sync-fs-dispatch.js';
import { resolveSyncFsToken } from './sync-fs-token-registry.js';
import {
  SYNC_FS_CHANNEL,
  type SyncFsAckMsg,
  type SyncFsReqMsg,
  type SyncFsResMsg,
} from './sync-fs-wire.js';

export { SYNC_FS_CHANNEL };

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

/**
 * Install the `slicc-sync-fs` responder. Pass a channel in tests; production
 * omits it and a `BroadcastChannel(SYNC_FS_CHANNEL)` is created + owned here.
 */
export function installSyncFsResponder(channel?: SyncFsChannelLike): SyncFsResponderHandle {
  const owned = channel === undefined;
  const ch: SyncFsChannelLike =
    channel ?? (new BroadcastChannel(SYNC_FS_CHANNEL) as unknown as SyncFsChannelLike);

  const post = (msg: SyncFsAckMsg | SyncFsResMsg): void => ch.postMessage(msg);

  const listener = (event: MessageEvent): void => {
    const data = event.data as Partial<SyncFsReqMsg> | undefined;
    if (data?.type !== 'sync-fs-req' || typeof data.id !== 'string') return;
    const req = data as SyncFsReqMsg;
    // Only THIS worker's realms are answerable here. A token we don't own
    // belongs to another same-origin worker (or is forged/revoked) — stay
    // silent so we can't win a race with a spurious EACCES (see header).
    if (!resolveSyncFsToken(req.token)) return;
    // Ack synchronously (before the async read) so the SW handler stops
    // re-posting during the cold-start listener race.
    post({ type: 'sync-fs-ack', id: req.id });
    // dispatchSyncFs is written not to reject, but a future ctx.fs could throw
    // synchronously (e.g. in resolvePath). Catch it and post a terminal errno
    // so the blocked realm worker never waits out the SW handler's full
    // timeout — fail closed, not hang.
    void dispatchSyncFs(req)
      .then((result) => post({ type: 'sync-fs-res', id: req.id, ...result }))
      .catch((err) =>
        post({
          type: 'sync-fs-res',
          id: req.id,
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
      if (owned) ch.close?.();
    },
  };
}
