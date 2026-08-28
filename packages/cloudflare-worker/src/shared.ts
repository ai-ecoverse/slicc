import type {
  TrayBootstrapEvent,
  TrayBootstrapFailure,
  TrayBootstrapState,
} from '@slicc/shared-ts';

export type TrayKind = 'desktop' | 'hosted';

/**
 * Worker-internal persisted bootstrap record (stored in `TrayRecord.bootstraps`).
 * Not wire contract — the wire shape derived from it is `TrayBootstrapStatus`
 * in `@slicc/shared-ts`.
 */
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
  /**
   * Set when this bootstrap was created by a biscotto (guest) capability. The
   * leader is told the trust level over its controller socket at
   * `follower.join_requested` time, so it never has to believe the peer's own
   * `hello` about what it is.
   */
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
  /**
   * Set when this controller first attached with a BISCOTTO capability rather
   * than the tray's join token. `controllerId` is client-supplied, so trust is
   * re-derived from the presented token on every request and merely CHECKED
   * against this field: a mismatch in either direction is rejected
   * (`JOIN_CAPABILITY_MISMATCH`) so a guest cannot inherit a full follower's
   * controller id, nor a full follower be downgraded by id collision.
   */
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

/**
 * Who settles an approval for one biscotto gate.
 *
 *  - `off`   — the gate is disabled; the action proceeds ungated.
 *  - `user`  — the cone owner's own approval surface (`SudoManager`).
 *  - `cone`  — the cone agent decides, via the same registry a scoop's
 *              cone-mediated sudo request uses (`ScoopApprovalRouter`).
 *  - `scoop` — a scoop the cone delegated the decision to; `BiscottoGate.scoop`
 *              names it.
 *
 * `off` is a member of this union rather than a separate boolean so that every
 * consumer must branch on the approver explicitly. A missing/unknown value
 * fails CLOSED (treated as `user`), never open — see `normalizeBiscottoGate`.
 */
export type BiscottoApprover = 'off' | 'user' | 'cone' | 'scoop' | 'agent';

export interface BiscottoGate {
  approver: BiscottoApprover;
  /** Scoop name that settles this gate. Only meaningful for `approver: 'scoop'`. */
  scoop?: string;
}

/**
 * The two independent gates on a biscotto, per the feature's design:
 *
 *  - `message` — each message the guest sends is reviewed before it reaches
 *    the cone (approve intent).
 *  - `tool` — each tool call the cone makes during a turn a guest caused is
 *    reviewed before it executes (approve consequences).
 */
export interface BiscottoGates {
  message: BiscottoGate;
  tool: BiscottoGate;
}

/**
 * One guest seat on a cone — a *biscotto*. The holder of `token` gets a
 * private URL that renders the live transcript and (subject to `gates`) can
 * send messages. It is NOT a follower capability: the tray DO resolves it to
 * `trust: 'biscotto'` and the leader allowlists a three-message subset of the
 * follower wire protocol for it. See `session-tray-biscotto.ts`.
 *
 * Stored in `TrayRecord.biscotti`, so a seat dies with its tray. Revocation is
 * a tombstone (`revokedAt`) rather than a delete: `biscotto log` can still name
 * the seat that was revoked, and a resolve against a revoked token is a plain
 * miss.
 */
export interface BiscottoRecord {
  /** Short stable handle the owner uses: `biscotto revoke <id>`. */
  id: string;
  /** Unguessable capability: `trayId.<hex>` per {@link createCapabilityToken}. */
  token: string;
  /** Human label the owner gave this guest, e.g. `Anna`. Rendered as message attribution. */
  label: string;
  createdAt: string;
  /** ISO deadline after which the seat stops resolving. Absent = lives as long as the tray. */
  expiresAt?: string;
  /** ISO revocation tombstone. Once set the token never resolves again. */
  revokedAt?: string;
  gates: BiscottoGates;
  /** Last successful attach. Informational, for `biscotti` listing. */
  lastSeenAt?: string;
}

/**
 * Upper bound on live seats per tray. Resolution is a linear timing-safe scan,
 * and an unbounded list would be both a scan cost and an invitation to use a
 * tray as a link shortener. Revoked seats do not count against it.
 */
export const MAX_BISCOTTI_PER_TRAY = 32;

/**
 * What a presented `/join/:token` capability turned out to be. `null` from
 * {@link resolveJoinCapability} means "no match" and MUST be treated as a 403 —
 * the resolver is the single default-deny point for the join surface.
 */
export type JoinCapability = { trust: 'full' } | { trust: 'biscotto'; biscotto: BiscottoRecord };

/**
 * Resolve a presented join capability against a tray, default-deny.
 *
 * Checks the tray's own join token first, then each live biscotto. Every
 * comparison goes through {@link timingSafeEqual} (via the injected `matches`)
 * so a guess cannot be narrowed by timing; the scan does NOT early-exit on the
 * first mismatch for that reason — it records the hit and keeps going.
 *
 * A biscotto that is revoked or past `expiresAt` does not resolve. `now` is
 * injected so the DO's clock seam and tests share one code path.
 */
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
    // Constant work per record: compare first, filter after. Skipping the
    // comparison for revoked/expired seats would leak their existence.
    const tokenMatches = matches(token, biscotto.token);
    if (!tokenMatches) continue;
    if (biscotto.revokedAt) continue;
    if (biscotto.expiresAt && Date.parse(biscotto.expiresAt) <= now) continue;
    hit = biscotto;
  }
  return hit ? { trust: 'biscotto', biscotto: hit } : null;
}

/**
 * Coerce a persisted or request-supplied gate into a known-good one.
 *
 * Fails CLOSED: an unrecognised approver becomes `user`, so a record written by
 * a newer build (or a hand-edited one) can never downgrade a gate to `off` on
 * an older worker. `scoop` without a name is likewise not a usable delegation,
 * so it falls back to `user` rather than silently approving.
 */
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

/**
 * One record per active `serve` invocation (many per tray). Stored in the
 * SessionTrayDurableObject's `tray.previews` map (added to TrayRecord below).
 * Live records die with the tray. Persistent records remain resolvable until
 * their own expiry and store immutable file bytes in R2.
 */
export interface PreviewRecord {
  previewToken: string; // unguessable: trayId.<20-byte-hex> per createCapabilityToken
  trayId: string;
  servedRoot: string; // VFS path: the security scope passed to the leader on every preview.request
  entryPath: string; // VFS path of the entry file (path === '/' resolves here)
  allowLive: boolean; // Phase 2 bridge-channel injection opt-in (Phase 1 ignores this)
  createdAt: string; // ISO timestamp
  cacheVersion: number; // bumped by preview.purge; incorporated into the worker cache key
  bridge: boolean; // driveable preview bridge enable (default false)
  maxTabs: number; // concurrent tab cap (default 20)
  webhookId?: string; // optional webhook identifier for bridge events
  userHash?: string; // first 8 hex chars of SHA-256(providerId:userName); absent for anonymous
  quiet: boolean; // suppresses the preview's first-visit announcement
  announced: boolean; // durable per-preview first-visit latch
  url?: string;
  mode?: 'live' | 'persistent';
  state?: 'pending' | 'ready' | 'cleanup';
  expiresAt?: string;
  retentionMs?: number;
  archivePrefix?: string;
  uploadToken?: string;
  uploadedFiles?: Record<string, { key: string; size: number; mime: string; etag: string }>;
  totalBytes?: number;
}

/**
 * One registered push device (issue #2062). Keyed by the APNs token in
 * `TrayRecord.pushTokens`; the DO forgets it when APNs says the token is dead
 * or when the tray record is pruned. The leader never sees tokens.
 */
export interface PushTokenRecord {
  platform: 'ios';
  environment: 'sandbox' | 'production';
  /** Follower bootstrap id that registered it (informational). */
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
  /**
   * Set by the leader (via `POST /api/tray/:trayId/supersede`, Bearer =
   * controllerToken) when it abandons this tray and mints a fresh one on
   * resume/reconnect (see `shouldRecreateTray` in the webapp's
   * `tray-leader.ts`). A follower hitting this tray's `/join/:token` gets
   * redirected here instead of dead-ending on `FOLLOWER_JOIN_NOT_READY` or
   * `TRAY_EXPIRED` forever — the old tray's leader socket will never come back.
   */
  supersededByJoinUrl?: string;
  /** Push devices to wake for `turn_end` / `sudo_request` (issue #2062). */
  pushTokens?: Record<string, PushTokenRecord>;
  /** Guest seats on this cone. Absent on trays minted before the feature. */
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
