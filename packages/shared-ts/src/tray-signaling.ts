/**
 * Tray signaling wire contract — single source of truth.
 *
 * Spoken on two wires:
 * 1. The leader's control WebSocket to the tray-hub worker
 *    (`LeaderToWorkerControlMessage` / `WorkerToLeaderControlMessage`).
 * 2. The follower's HTTP bootstrap API on the worker
 *    (`FollowerBootstrapRequest` → `FollowerAttachResponse` /
 *    `FollowerBootstrapResponse`).
 *
 * Consumed by `packages/webapp` (leader + TS follower) and
 * `packages/cloudflare-worker` (SessionTray Durable Object). The iOS follower
 * mirrors a subset in `packages/ios-app/SliccFollower/Models/TrayTypes.swift`
 * — update that mirror when this file changes.
 *
 * Worker-internal persisted state (`TrayBootstrapRecord`, `TrayRecord`) is NOT
 * wire contract and lives in `packages/cloudflare-worker/src/shared.ts`.
 */

export const TRAY_BOOTSTRAP_TIMEOUT_MS = 20_000;
export const TRAY_BOOTSTRAP_MAX_RETRIES = 3;
export const TRAY_BOOTSTRAP_RETRY_AFTER_MS = 1_000;

export type TrayBootstrapState = 'pending' | 'offered' | 'connected' | 'failed';

export interface TraySessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface TrayIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface TrayBootstrapFailure {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  failedAt: string;
}

export type TrayBootstrapEvent =
  | {
      sequence: number;
      sentAt: string;
      type: 'bootstrap.offer';
      offer: TraySessionDescription;
    }
  | {
      sequence: number;
      sentAt: string;
      type: 'bootstrap.ice_candidate';
      candidate: TrayIceCandidate;
    }
  | {
      sequence: number;
      sentAt: string;
      type: 'bootstrap.failed';
      failure: TrayBootstrapFailure;
    };

export interface TrayBootstrapStatus {
  controllerId: string;
  bootstrapId: string;
  attempt: number;
  state: TrayBootstrapState;
  expiresAt: string;
  cursor: number;
  maxRetries: number;
  retriesRemaining: number;
  retryAfterMs: number | null;
  failure: TrayBootstrapFailure | null;
}

export interface TurnIceServer {
  urls: string[];
  username: string;
  credential: string;
}

// ---------------------------------------------------------------------------
// Worker → leader control messages
// ---------------------------------------------------------------------------

export interface FollowerJoinRequestedMessage {
  type: 'follower.join_requested';
  trayId: string;
  controllerId: string;
  runtime?: string;
  bootstrapId: string;
  attempt: number;
  expiresAt: string;
  iceServers?: TurnIceServer[];
}

export interface BootstrapAnswerMessage {
  type: 'bootstrap.answer';
  trayId: string;
  controllerId: string;
  bootstrapId: string;
  answer: TraySessionDescription;
}

export interface BootstrapIceCandidateMessage {
  type: 'bootstrap.ice_candidate';
  trayId: string;
  controllerId: string;
  bootstrapId: string;
  candidate: TrayIceCandidate;
}

export interface WebhookEventMessage {
  type: 'webhook.event';
  webhookId: string;
  headers: Record<string, string>;
  body: unknown;
  timestamp: string;
}

export interface WorkerPreviewRequest {
  type: 'preview.request';
  reqId: string;
  servedRoot: string;
  vfsPath: string;
  asText: boolean;
}

export interface WorkerPreviewRevoked {
  type: 'preview.revoked';
  previewToken: string;
}

export interface WorkerBridgeConnected {
  type: 'bridge.connected';
  connId: string;
  previewToken: string;
  origin: string;
  userAgent: string;
  connectedAt: string;
}

export interface WorkerBridgeDisconnected {
  type: 'bridge.disconnected';
  connId: string;
  reason?: string;
}

export interface WorkerBridgeCdpResponse {
  type: 'bridge.cdp.response';
  connId: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export type WorkerToLeaderControlMessage =
  | {
      type: 'leader.connected';
      trayId: string;
      controllerId: string;
    }
  | {
      type: 'pong';
      trayId: string;
    }
  | FollowerJoinRequestedMessage
  | BootstrapAnswerMessage
  | BootstrapIceCandidateMessage
  | WebhookEventMessage
  | WorkerPreviewRequest
  | WorkerPreviewRevoked
  | WorkerBridgeConnected
  | WorkerBridgeDisconnected
  | WorkerBridgeCdpResponse;

// ---------------------------------------------------------------------------
// Leader → worker control messages
// ---------------------------------------------------------------------------

export interface LeaderBootstrapOfferMessage {
  type: 'bootstrap.offer';
  controllerId: string;
  bootstrapId: string;
  offer: TraySessionDescription;
}

export interface LeaderBootstrapIceCandidateMessage {
  type: 'bootstrap.ice_candidate';
  controllerId: string;
  bootstrapId: string;
  candidate: TrayIceCandidate;
}

export interface LeaderBootstrapFailedMessage {
  type: 'bootstrap.failed';
  controllerId: string;
  bootstrapId: string;
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number | null;
}

export interface LeaderPreviewResponseOk {
  type: 'preview.response';
  reqId: string;
  ok: true;
  mime: string;
  chunkIndex: number;
  totalChunks: number;
  /** utf-8 text OR base64-encoded binary, per `encoding`. */
  content: string;
  encoding: 'utf-8' | 'base64';
}

export interface LeaderPreviewResponseError {
  type: 'preview.response';
  reqId: string;
  ok: false;
  status: 404 | 403 | 500;
  reason?: string;
}

// ponytail: consumer wired (session-tray.ts), producer deferred — needs FsWatcher→page bridge
export interface LeaderPreviewPurge {
  type: 'preview.purge';
  previewToken: string;
}

export interface LeaderBridgeCdpRequest {
  type: 'bridge.cdp.request';
  connId: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** Leader → worker: close a bridged preview visitor tab's connection (from
 *  `Target.closeTarget` on a `preview:<token>:<connId>` target). */
export interface LeaderBridgeClose {
  type: 'bridge.close';
  connId: string;
}

export type LeaderToWorkerControlMessage =
  | { type: 'ping' }
  | LeaderBootstrapOfferMessage
  | LeaderBootstrapIceCandidateMessage
  | LeaderBootstrapFailedMessage
  | LeaderPreviewResponseOk
  | LeaderPreviewResponseError
  | LeaderPreviewPurge
  | LeaderBridgeCdpRequest
  | LeaderBridgeClose;

// ---------------------------------------------------------------------------
// Follower HTTP bootstrap API — requests (follower → worker)
// ---------------------------------------------------------------------------

export interface BootstrapPollRequest {
  action: 'poll';
  controllerId?: string;
  bootstrapId?: string;
  cursor?: number;
}

export interface BootstrapAnswerRequest {
  action: 'answer';
  controllerId?: string;
  bootstrapId?: string;
  answer?: TraySessionDescription;
}

export interface BootstrapIceCandidateRequest {
  action: 'ice-candidate';
  controllerId?: string;
  bootstrapId?: string;
  candidate?: TrayIceCandidate;
}

export interface BootstrapRetryRequest {
  action: 'retry';
  controllerId?: string;
  bootstrapId?: string;
  runtime?: string;
}

export type FollowerBootstrapRequest =
  | BootstrapPollRequest
  | BootstrapAnswerRequest
  | BootstrapIceCandidateRequest
  | BootstrapRetryRequest;

// ---------------------------------------------------------------------------
// Follower HTTP bootstrap API — responses (worker → follower)
// ---------------------------------------------------------------------------

export interface TrayLeaderSummary {
  controllerId: string;
  connected: boolean;
  reconnectDeadline: string | null;
}

export interface FollowerJoinRequest {
  controllerId?: string;
  runtime?: string;
}

export type FollowerAttachResult =
  | {
      action: 'wait';
      code: 'LEADER_NOT_ELECTED' | 'LEADER_NOT_CONNECTED';
      retryAfterMs: number;
    }
  | {
      action: 'signal';
      code: 'LEADER_CONNECTED';
      bootstrap: TrayBootstrapStatus;
    }
  | {
      action: 'fail';
      code: 'INVALID_JOIN_CAPABILITY' | 'TRAY_EXPIRED';
      error: string;
    };

export interface FollowerAttachResponse {
  trayId: string;
  controllerId: string;
  role: 'follower';
  leader: TrayLeaderSummary | null;
  participantCount: number;
  result: FollowerAttachResult;
  iceServers?: TurnIceServer[];
}

export interface FollowerBootstrapResponse {
  trayId: string;
  controllerId: string;
  role: 'follower';
  leader: TrayLeaderSummary | null;
  participantCount: number;
  bootstrap: TrayBootstrapStatus;
  events: TrayBootstrapEvent[];
  iceServers?: TurnIceServer[];
}
