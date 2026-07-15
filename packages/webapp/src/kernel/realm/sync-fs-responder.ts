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
 * Wire protocol (mirrors `preview-vfs-responder.ts`):
 *   SW → responder:  { type: 'sync-fs-req', id, ...SyncFsRequest }
 *   responder → SW:  { type: 'sync-fs-ack', id }      (posted synchronously)
 *                    { type: 'sync-fs-res', id, ...SyncFsResult }
 *
 * The ack is posted BEFORE the async dispatch so the SW handler can stop its
 * cold-start re-post loop (BroadcastChannel drops messages to a listener that
 * is not yet attached — see `preview-sw-handler.ts`).
 */

import { dispatchSyncFs, type SyncFsRequest, type SyncFsResult } from './sync-fs-dispatch.js';

/** Structural subset of `BroadcastChannel` so tests can inject a fake. */
export interface SyncFsChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close?(): void;
}

export type SyncFsReqMsg = SyncFsRequest & { type: 'sync-fs-req'; id: string };
export type SyncFsAckMsg = { type: 'sync-fs-ack'; id: string };
export type SyncFsResMsg = SyncFsResult & { type: 'sync-fs-res'; id: string };

export const SYNC_FS_CHANNEL = 'slicc-sync-fs';

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

  const listener = (event: MessageEvent): void => {
    const data = event.data as Partial<SyncFsReqMsg> | undefined;
    if (data?.type !== 'sync-fs-req' || typeof data.id !== 'string') return;
    const req = data as SyncFsReqMsg;
    // Ack synchronously (before the async read) so the SW handler stops
    // re-posting during the cold-start listener race.
    ch.postMessage({ type: 'sync-fs-ack', id: req.id } satisfies SyncFsAckMsg);
    void dispatchSyncFs(req).then((result) => {
      ch.postMessage({ type: 'sync-fs-res', id: req.id, ...result } satisfies SyncFsResMsg);
    });
  };

  ch.addEventListener('message', listener);
  return {
    dispose: () => {
      ch.removeEventListener('message', listener);
      if (owned) ch.close?.();
    },
  };
}
