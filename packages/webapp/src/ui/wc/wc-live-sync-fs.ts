import {
  SYNC_FS_NEED_NONCE_MSG,
  SYNC_FS_NONCE_MSG,
  type SyncFsNeedNonceMsg,
  type SyncFsNonce,
  type SyncFsNonceMsg,
} from '../../kernel/realm/sync-fs-wire.js';

export interface SyncFsBootState {
  syncFsBridgeEnabled: boolean;
  syncFsChannelNonce?: SyncFsNonce;
}

/** Mint and keep alive the private page↔service-worker sync-FS channel nonce. */
export function setupSyncFsBootNonce(
  deps: {
    navigator?: Navigator;
    document?: Document;
    window?: Window;
    randomUUID?: () => string;
  } = {}
): SyncFsBootState {
  const nav = deps.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const doc = deps.document ?? (typeof document !== 'undefined' ? document : undefined);
  const win = deps.window ?? (typeof window !== 'undefined' ? window : undefined);
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const syncFsBridgeEnabled = !!nav?.serviceWorker?.controller;
  const syncFsChannelNonce = syncFsBridgeEnabled ? (randomUUID() as SyncFsNonce) : undefined;

  if (!syncFsChannelNonce || !nav?.serviceWorker) {
    return { syncFsBridgeEnabled, syncFsChannelNonce };
  }

  const sw = nav.serviceWorker;
  const nonceMsg: SyncFsNonceMsg = { type: SYNC_FS_NONCE_MSG, nonce: syncFsChannelNonce };
  const publishNonce = (): void => sw.controller?.postMessage(nonceMsg);
  publishNonce();
  sw.addEventListener('controllerchange', publishNonce);
  sw.addEventListener('message', (event: MessageEvent) => {
    if ((event.data as SyncFsNeedNonceMsg | undefined)?.type === SYNC_FS_NEED_NONCE_MSG) {
      publishNonce();
    }
  });
  doc?.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') publishNonce();
  });
  win?.addEventListener('focus', publishNonce);

  return { syncFsBridgeEnabled, syncFsChannelNonce };
}
