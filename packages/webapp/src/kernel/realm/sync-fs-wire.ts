import type { SyncExecRequest } from './sync-exec-dispatch.js';
import type { SyncFsRequest, SyncFsResult } from './sync-fs-dispatch.js';

export type SyncFsToken = string & { readonly __syncFsToken: unique symbol };
export type SyncFsNonce = string & { readonly __syncFsNonce: unique symbol };

const SYNC_FS_CHANNEL_PREFIX = 'slicc-sync-fs-';
export function syncFsChannelName(nonce: SyncFsNonce): string {
  return SYNC_FS_CHANNEL_PREFIX + nonce;
}

export const SYNC_FS_NONCE_MSG = 'sync-fs-nonce';
export interface SyncFsNonceMsg {
  type: typeof SYNC_FS_NONCE_MSG;
  nonce: SyncFsNonce;
}

export const SYNC_FS_NEED_NONCE_MSG = 'sync-fs-need-nonce';
export interface SyncFsNeedNonceMsg {
  type: typeof SYNC_FS_NEED_NONCE_MSG;
}

export const SYNC_FS_ROUTE_PREFIX = '/__slicc/fs-sync/';

export const SYNC_FS_ROUTE_BASE = '/__slicc/fs-sync';

export const SYNC_EXEC_ROUTE = '/__slicc/exec-sync';

export const SYNC_FS_TOKEN_HEADER = 'x-slicc-fs-token';

export const SYNC_FS_ERRNO_HEADER = 'x-slicc-fs-errno';

export const SYNC_FS_MARKER_HEADER = 'x-slicc-fs';

export const SYNC_FS_NO_RESPONDER_HEADER = 'x-slicc-fs-no-responder';

export const SYNC_FS_REQ_MSG = 'sync-fs-req';
export const SYNC_FS_ACK_MSG = 'sync-fs-ack';
export const SYNC_FS_RES_MSG = 'sync-fs-res';

export type SyncFsReqMsg = (SyncFsRequest | SyncExecRequest) & {
  type: typeof SYNC_FS_REQ_MSG;
  id: string;
};

export type SyncFsAckMsg = { type: typeof SYNC_FS_ACK_MSG; id: string };

export type SyncFsResMsg = SyncFsResult & { type: typeof SYNC_FS_RES_MSG; id: string };

export const SYNC_FS_REQUEST_TIMEOUT_MS = 25_000;

export const SYNC_FS_NONCE_WAIT_MS = 2_000;

export const SYNC_EXEC_DEFAULT_TIMEOUT_MS = 120_000;

export const SYNC_EXEC_MAX_TIMEOUT_MS = 600_000;

export const SYNC_EXEC_RESPONSE_MARGIN_MS = 2_000;

export const SYNC_EXEC_XHR_MARGIN_MS = 5_000;
