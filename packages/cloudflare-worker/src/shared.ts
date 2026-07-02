import type {
  TrayBootstrapEvent,
  TrayBootstrapRecord,
  TrayBootstrapStatus,
  TurnIceServer,
} from './tray-signaling.js';

export type TrayKind = 'desktop' | 'hosted';

export const TRAY_RECLAIM_TTL_MS = 60 * 60 * 1000;
export const HOSTED_TRAY_RECLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const FOLLOWER_ATTACH_RETRY_AFTER_MS = 1_000;

export function reclaimMsForTray(tray: TrayRecord | null | undefined): number {
  return tray?.kind === 'hosted' ? HOSTED_TRAY_RECLAIM_TTL_MS : TRAY_RECLAIM_TTL_MS;
}

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStubLike {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  acceptWebSocket?(ws: unknown, tags?: string[]): void;
  getWebSockets?(tag?: string): unknown[];
  getTags?(ws: unknown): string[];
  setWebSocketAutoResponse?(ws: unknown, response?: unknown): void;
}

export interface TrayWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

export interface ControllerRecord {
  controllerId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  runtime?: string;
}

export interface LeaderRecord {
  controllerId: string;
  leaderKey: string;
  claimedAt: string;
  lastSeenAt: string;
  connected: boolean;
  disconnectedAt?: string;
}

/**
 * One record per active `serve` invocation (many per tray). Stored in the
 * SessionTrayDurableObject's `tray.previews` map (added to TrayRecord below).
 * Deleted on tray expiry OR on explicit `serve --stop` revoke.
 */
export interface PreviewRecord {
  previewToken: string; // unguessable: trayId.<18-byte-hex> per createCapabilityToken
  trayId: string;
  servedRoot: string; // VFS path: the security scope passed to the leader on every preview.request
  entryPath: string; // VFS path of the entry file (path === '/' resolves here)
  allowLive: boolean; // Phase 2 bridge-channel injection opt-in (Phase 1 ignores this)
  createdAt: string; // ISO timestamp
  cacheVersion: number; // bumped by preview.purge; incorporated into the worker cache key
  bridge: boolean; // driveable preview bridge enable (default false)
  maxTabs: number; // concurrent tab cap (default 20)
  webhookId?: string; // optional webhook identifier for bridge events
}

export interface TrayRecord {
  trayId: string;
  createdAt: string;
  joinToken: string;
  controllerToken: string;
  webhookToken: string;
  controllers: Record<string, ControllerRecord>;
  bootstraps: Record<string, TrayBootstrapRecord>;
  leader: LeaderRecord | null;
  expiredAt?: string;
  kind?: TrayKind;
  previews?: Record<string, PreviewRecord>;
}

export interface CreateTrayRequest {
  trayId: string;
  createdAt: string;
  joinToken: string;
  controllerToken: string;
  webhookToken: string;
  kind?: TrayKind;
}

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

export function createCapabilityToken(trayId: string, bytes = 18): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  const secret = Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${trayId}.${secret}`;
}

export function parseCapabilityToken(token: string): { trayId: string; secret: string } | null {
  const [trayId, secret, ...rest] = token.split('.');
  if (!trayId || !secret || rest.length > 0) {
    return null;
  }
  return { trayId, secret };
}

export function wantsJSON(request: Request): boolean {
  const url = new URL(request.url);
  return url.searchParams.get('json') === 'true';
}

export function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

export function websocketResponse(client: unknown): Response {
  try {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & {
      webSocket: unknown;
    });
  } catch {
    return {
      status: 101,
      headers: new Headers(),
      webSocket: client,
    } as unknown as Response;
  }
}
