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
 * mirrors a subset in `packages/ios-app/SliccTrayKit/Models/TrayTypes.swift`
 * — update that mirror when this file changes.
 *
 * Worker-internal persisted state (`TrayBootstrapRecord`, `TrayRecord`) is NOT
 * wire contract and lives in `packages/cloudflare-worker/src/shared.ts`.
 */

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

/** Leader → worker: close a bridged preview visitor tab's connection (from
 *  `Target.closeTarget` on a `preview:<token>:<connId>` target). */
export interface LeaderBridgeClose {
  type: 'bridge.close';
  connId: string;
}

/**
 * Leader → worker: a follower registered a push token (`push.register` on the
 * data channel, forwarded verbatim plus the follower's bootstrap id). The tray
 * DO stores it; the leader never does (issue #2062).
 */
export interface LeaderPushRegister {
  type: 'push.register';
  bootstrapId: string;
  platform: 'ios';
  token: string;
  environment: 'sandbox' | 'production';
}

/**
 * Leader → worker: wake every registered device. Metadata only — the body
 * names the scoop and the category; the phone reconnects and fetches the real
 * request over the data channel. `requestId` lets the DO collapse duplicate
 * sudo pushes and lets the app deep-link to the right card.
 */
export interface LeaderPushSend {
  type: 'push.send';
  category: 'turn_end' | 'sudo_request';
  /** Human label for the banner (scoop name). Never transcript text. */
  label: string;
  requestId?: string;
}

export type LeaderToWorkerControlMessage =
  | { type: 'ping' }
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
  /** ISO timestamp of the leader's last application-level message. */
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
      action: 'fail';
      code: 'TRAY_SUPERSEDED';
      error: string;
      joinUrl: string;
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

/**
 * RFC 5829 relation the tray hub stamps on a superseded tray's response,
 * pointing at the replacement tray's join URL. See the worker's
 * `supersededLinkHeaders` (`packages/cloudflare-worker/src/links.ts`) and
 * `https://www.sliccy.ai/rel/successor-version`.
 */
export const SUCCESSOR_VERSION_REL = 'successor-version';

/**
 * Pull the `successor-version` target out of an RFC 8288 `Link` header.
 *
 * Deliberately narrow: the tray hub emits one well-formed link plus its
 * standard rel set, so this handles the shapes that actually arrive —
 * comma-separated link-values (commas inside quoted strings preserved),
 * `rel=token` and `rel="quoted token-list"`, and multiple header instances
 * joined by `,` or `\n` — rather than reimplementing the full grammar. The
 * webapp's `src/net/link-header.ts` is the complete parser; it can't live here
 * because shared-ts must not depend on webapp, and this contract's home is
 * next to the response type it annotates.
 *
 * Returns the first matching absolute URL, or null. Relative references are
 * rejected: a replacement tray is always absolute, and resolving one against
 * the wrong base would dial an unusable address.
 */
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
      // Absolute-only: `new URL` throws on a bare relative reference.
      return new URL(target).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Split on `sep` at the top level — commas/semicolons inside a quoted-string
 * or an angle-bracketed URI-reference belong to the value, not the grammar.
 * (A `Link` target may legitimately contain both: `<https://a/b;c?d,e>`.)
 */
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

/** True when a link-value's parameter list declares `rel=successor-version`. */
function hasSuccessorVersionRel(params: string): boolean {
  for (const param of splitOutsideQuotes(params, ';')) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'rel') continue;
    const value = param
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/s, '$1');
    // `rel` is a space-separated list of relation types, matched case-insensitively.
    if (value.split(/\s+/).some((tok) => tok.toLowerCase() === SUCCESSOR_VERSION_REL)) {
      return true;
    }
  }
  return false;
}
