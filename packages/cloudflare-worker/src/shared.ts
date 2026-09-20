import type {
  TrayBootstrapEvent,
  TrayBootstrapFailure,
  TrayBootstrapState,
} from '@slicc/shared-ts';
import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';

export type TrayKind = 'desktop' | 'hosted';

const ALLOWED_ORIGINS = [
  SLICC_HOSTED_ORIGIN,
  'https://sliccy.ai',
  /^https:\/\/slicc-tray-hub[^.]*\.minivelos\.workers\.dev$/,
  /^http:\/\/localhost:\d+$/,
];

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.some((allowed) =>
    typeof allowed === 'string' ? allowed === origin : allowed.test(origin)
  );
}

export interface TrayBootstrapRecord {
  controllerId: string;
  bootstrapId: string;
  runtime?: string;
  attempt: number;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  state: TrayBootstrapState;
  failure: TrayBootstrapFailure | null;
  events: TrayBootstrapEvent[];
  nextSequence: number;

  biscottoId?: string;
}

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
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  acceptWebSocket?(ws: unknown, tags?: string[]): void;
  getWebSockets?(tag?: string): unknown[];
  getTags?(ws: unknown): string[];
  setWebSocketAutoResponse?(pair: unknown): void;
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

  biscottoId?: string;
}

export interface LeaderRecord {
  controllerId: string;
  leaderKey: string;
  claimedAt: string;
  lastSeenAt: string;
  connected: boolean;
  disconnectedAt?: string;
}

export type BiscottoApprover = 'off' | 'user' | 'cone' | 'scoop' | 'agent';

export interface BiscottoGate {
  approver: BiscottoApprover;

  scoop?: string;
}

export interface BiscottoGates {
  message: BiscottoGate;
  tool: BiscottoGate;
}

export interface BiscottoRecord {
  id: string;

  token: string;

  label: string;
  createdAt: string;

  expiresAt?: string;

  revokedAt?: string;
  gates: BiscottoGates;

  lastSeenAt?: string;
}

export const MAX_BISCOTTI_PER_TRAY = 32;

export type JoinCapability = { trust: 'full' } | { trust: 'biscotto'; biscotto: BiscottoRecord };

export function resolveJoinCapability(
  tray: Pick<TrayRecord, 'joinToken' | 'biscotti'>,
  token: string,
  now: number,
  matches: (received: string, expected: string) => boolean
): JoinCapability | null {
  if (matches(token, tray.joinToken)) {
    return { trust: 'full' };
  }
  let hit: BiscottoRecord | null = null;
  for (const biscotto of tray.biscotti ?? []) {
    const tokenMatches = matches(token, biscotto.token);
    if (!tokenMatches) continue;
    if (biscotto.revokedAt) continue;
    if (biscotto.expiresAt && Date.parse(biscotto.expiresAt) <= now) continue;
    hit = biscotto;
  }
  return hit ? { trust: 'biscotto', biscotto: hit } : null;
}

export function normalizeBiscottoGate(gate: Partial<BiscottoGate> | undefined): BiscottoGate {
  const approver = gate?.approver;
  if (approver === 'off' || approver === 'user' || approver === 'cone') {
    return { approver };
  }
  if (approver === 'scoop' && typeof gate?.scoop === 'string' && gate.scoop.length > 0) {
    return { approver: 'scoop', scoop: gate.scoop };
  }
  return { approver: 'user' };
}

export interface PreviewRecord {
  previewToken: string;
  trayId: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
  createdAt: string;
  cacheVersion: number;
  bridge: boolean;
  maxTabs: number;
  webhookId?: string;
  userHash?: string;
  quiet: boolean;
  announced: boolean;
  url?: string;
  mode?: 'live' | 'persistent';
  state?: 'pending' | 'ready' | 'cleanup';
  expiresAt?: string;
  retentionMs?: number;
  archivePrefix?: string;
  uploadToken?: string;
  uploadedFiles?: Record<
    string,
    { key: string; size: number; mime: string; etag: string; sha256?: string }
  >;
  totalBytes?: number;

  pendingUploadKeys?: string[];
  pendingUploads?: { objectKey: string; leasedAt: number }[];

  hasUnsettledUploads?: boolean;

  cleanupUntil?: number;
}

export interface PushTokenRecord {
  platform: 'ios';
  environment: 'sandbox' | 'production';

  bootstrapId: string;
  registeredAt: string;
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

  previewForwarding?: Record<string, string>;

  previewTransfer?: {
    id: string;
    targetTrayId: string;
    tokens: string[];
    phase: 'pending' | 'forwarded' | 'complete';
  };
  previewImports?: Record<string, { id: string; activated: boolean }>;

  supersededByJoinUrl?: string;

  supersededByWebhookUrl?: string;

  pushTokens?: Record<string, PushTokenRecord>;

  biscotti?: BiscottoRecord[];
}

export interface CreateTrayRequest {
  trayId: string;
  createdAt: string;
  joinToken: string;
  controllerToken: string;
  webhookToken: string;
  kind?: TrayKind;
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

export function extractBearer(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
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
