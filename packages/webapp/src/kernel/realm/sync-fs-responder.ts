import { dispatchSyncExec, isSyncExecRequest } from './sync-exec-dispatch.js';
import { dispatchSyncFs, type SyncFsResult } from './sync-fs-dispatch.js';
import { resolveSyncFsToken } from './sync-fs-token-registry.js';
import {
  SYNC_EXEC_MAX_TIMEOUT_MS,
  SYNC_FS_ACK_MSG,
  SYNC_FS_REQ_MSG,
  SYNC_FS_REQUEST_TIMEOUT_MS,
  SYNC_FS_RES_MSG,
  type SyncFsAckMsg,
  type SyncFsNonce,
  type SyncFsReqMsg,
  type SyncFsResMsg,
  syncFsChannelName,
} from './sync-fs-wire.js';

const DEDUPE_TTL_MS = Math.max(SYNC_FS_REQUEST_TIMEOUT_MS, SYNC_EXEC_MAX_TIMEOUT_MS) + 5_000;

export interface SyncFsChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close?(): void;
}

export interface SyncFsResponderHandle {
  dispose(): void;
}

interface DedupeEntry {
  result?: SyncFsResult;

  timer?: ReturnType<typeof setTimeout>;
}

export function installSyncFsResponder(
  opts: { nonce?: SyncFsNonce; channel?: SyncFsChannelLike } = {}
): SyncFsResponderHandle {
  const owned = opts.channel === undefined;
  if (owned && !opts.nonce) {
    throw new Error('installSyncFsResponder: a nonce (or a test channel) is required');
  }
  const ch: SyncFsChannelLike =
    opts.channel ??
    (new BroadcastChannel(
      syncFsChannelName(opts.nonce as SyncFsNonce)
    ) as unknown as SyncFsChannelLike);

  const post = (msg: SyncFsAckMsg | SyncFsResMsg): void => ch.postMessage(msg);

  const seen = new Map<string, DedupeEntry>();

  const listener = (event: MessageEvent): void => {
    const data = event.data as Partial<SyncFsReqMsg> | undefined;
    if (data?.type !== SYNC_FS_REQ_MSG || typeof data.id !== 'string') return;
    const req = data as SyncFsReqMsg;

    if (!resolveSyncFsToken(req.token)) return;

    const existing = seen.get(req.id);
    if (existing) {
      post({ type: SYNC_FS_ACK_MSG, id: req.id });
      if (existing.result) post({ type: SYNC_FS_RES_MSG, id: req.id, ...existing.result });
      return;
    }

    const entry: DedupeEntry = {};
    seen.set(req.id, entry);

    post({ type: SYNC_FS_ACK_MSG, id: req.id });

    const settle = (result: SyncFsResult): void => {
      entry.result = result;

      entry.timer = setTimeout(() => seen.delete(req.id), DEDUPE_TTL_MS);
      post({ type: SYNC_FS_RES_MSG, id: req.id, ...result });
    };

    const dispatched = isSyncExecRequest(req) ? dispatchSyncExec(req) : dispatchSyncFs(req);
    void dispatched.then(settle).catch((err) =>
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
