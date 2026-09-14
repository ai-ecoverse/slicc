import type { CDPPayload } from './tray-sync-protocol.js';

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

export type FollowerTrust = 'full' | 'biscotto';

export interface FollowerJoinRequestedMessage {
  type: 'follower.join_requested';
  trayId: string;
  controllerId: string;
  runtime?: string;
  bootstrapId: string;
  attempt: number;
  expiresAt: string;
  iceServers?: TurnIceServer[];

  trust?: FollowerTrust;

  biscotto?: FollowerBiscottoIdentity;
}

export interface FollowerBiscottoIdentity {
  id: string;

  expiresAt?: string;

  label: string;

  gates: FollowerBiscottoGates;
}

export interface FollowerBiscottoGates {
  message: FollowerBiscottoGate;
  tool: FollowerBiscottoGate;
}

export interface FollowerBiscottoGate {
  approver: 'off' | 'user' | 'cone' | 'scoop' | 'agent';
  scoop?: string;
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

  deliveryId?: string;
}

export type WebhookDeliveryDisposition =
  | 'delivered'
  | 'filtered'
  | 'unknown-webhook'
  | 'unresolved-target';

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

export interface WorkerPreviewState {
  type: 'preview.state';
  previewToken: string;
  quiet: boolean;
  announced: boolean;
}

export interface WorkerBridgeConnected {
  type: 'bridge.connected';
  connId: string;
  previewToken: string;
  origin: string;
  userAgent: string;
  connectedAt: string;
  replay?: true;
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
  result?: CDPPayload;
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
  | WorkerPreviewState
  | WorkerBridgeConnected
  | WorkerBridgeDisconnected
  | WorkerBridgeCdpResponse
  | BiscottoRevokedMessage;

export interface BiscottoRevokedMessage {
  type: 'biscotto.revoked';
  trayId: string;
  biscottoId: string;
}

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

export interface LeaderPreviewPurge {
  type: 'preview.purge';
  previewToken: string;
}

export interface LeaderPreviewStateUpdate {
  type: 'preview.state.update';
  previewToken: string;
  announced: boolean;
}

export interface LeaderBridgeCdpRequest {
  type: 'bridge.cdp.request';
  connId: string;
  id: number;
  method: string;
  params?: CDPPayload;
  sessionId?: string;
}

export interface LeaderBridgeClose {
  type: 'bridge.close';
  connId: string;
}

export interface LeaderPushRegister {
  type: 'push.register';
  bootstrapId: string;
  platform: 'ios';
  token: string;
  environment: 'sandbox' | 'production';
}

export interface LeaderPushSend {
  type: 'push.send';
  category: 'turn_end' | 'sudo_request';

  label: string;
  requestId?: string;
}

export interface LeaderWebhookDelivery {
  type: 'webhook.delivery';
  deliveryId: string;
  disposition: WebhookDeliveryDisposition;
}

export type LeaderToWorkerControlMessage =
  | { type: 'ping' }
  | LeaderWebhookDelivery
  | LeaderPushRegister
  | LeaderPushSend
  | LeaderBootstrapOfferMessage
  | LeaderBootstrapIceCandidateMessage
  | LeaderBootstrapFailedMessage
  | LeaderPreviewResponseOk
  | LeaderPreviewResponseError
  | LeaderPreviewPurge
  | LeaderPreviewStateUpdate
  | LeaderBridgeCdpRequest
  | LeaderBridgeClose;

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

export interface TrayLeaderSummary {
  controllerId: string;
  connected: boolean;
  reconnectDeadline: string | null;

  lastSeenAt?: string;
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
    }
  | {
      action: 'redirect';
      code: 'TRAY_SUPERSEDED';
      error: string;
      joinUrl: string;
    }
  | {
      action: 'fail';
      code: 'TRAY_SUPERSEDED';
      error: string;
      joinUrl: string;
    };

export interface FollowerAttachResponse {
  trayId: string;
  controllerId: string;
  role: 'follower';

  trust?: FollowerTrust;
  leader: TrayLeaderSummary | null;
  participantCount: number;
  result: FollowerAttachResult;
  iceServers?: TurnIceServer[];
}

export interface FollowerBootstrapResponse {
  trayId: string;
  controllerId: string;
  role: 'follower';

  trust?: FollowerTrust;
  leader: TrayLeaderSummary | null;
  participantCount: number;
  bootstrap: TrayBootstrapStatus;
  events: TrayBootstrapEvent[];
  iceServers?: TurnIceServer[];
}

export const SUCCESSOR_VERSION_REL = 'successor-version';

export function successorVersionFromLinkHeader(
  header: string | string[] | null | undefined
): string | null {
  if (header == null) return null;
  const raw = (Array.isArray(header) ? header.join(', ') : header).replace(/\n/g, ', ');
  for (const value of splitOutsideQuotes(raw, ',')) {
    const uriEnd = value.indexOf('>');
    if (!value.startsWith('<') || uriEnd === -1) continue;
    const target = value.slice(1, uriEnd).trim();
    if (!hasSuccessorVersionRel(value.slice(uriEnd + 1))) continue;
    try {
      return new URL(target).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function splitOutsideQuotes(input: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuotes = false;
  let inAngle = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '\\') i++;
      else if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === '<') inAngle = true;
    else if (ch === '>') inAngle = false;
    else if (ch === sep && !inAngle) {
      out.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(input.slice(start).trim());
  return out.filter(Boolean);
}

function hasSuccessorVersionRel(params: string): boolean {
  for (const param of splitOutsideQuotes(params, ';')) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'rel') continue;
    const value = param
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/s, '$1');

    if (value.split(/\s+/).some((tok) => tok.toLowerCase() === SUCCESSOR_VERSION_REL)) {
      return true;
    }
  }
  return false;
}
