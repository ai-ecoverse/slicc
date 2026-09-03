/**
 * `SessionTrayDurableObject` — the tray hub's per-tray coordinator.
 *
 * One durable object per tray. It owns the things that are genuinely about
 * *this tray as a whole*: the tray record and its persistence, the leader's
 * controller WebSocket (election, reclaim, staleness), the join/attach surface,
 * and route dispatch.
 *
 * Everything else is a collaborator behind a `*Deps` seam, so each concern is
 * unit-testable without a DO harness and this file stays a coordinator rather
 * than a god class (issue #2674):
 *
 * - `session-tray-bootstrap.ts` — follower WebRTC signaling state machine
 * - `session-tray-bridge.ts` — preview-bridge CDP relay + `slicc.emit()`
 * - `session-tray-preview.ts` — preview mint/resolve/revoke + response assembly
 * - `session-tray-biscotto.ts` — guest seat lifecycle
 * - `session-tray-webhook.ts` — webhook relay + delivery receipts
 * - `session-tray-push.ts` — APNs device registry + fan-out
 * - `session-tray-requests.ts` — pure request parsing / wire-shape guards
 */

import {
  type FollowerAttachResponse,
  type FollowerAttachResult,
  type FollowerTrust,
  type LeaderToWorkerControlMessage,
  TRAY_BOOTSTRAP_MAX_RETRIES,
  TRAY_BOOTSTRAP_RETRY_AFTER_MS,
  TRAY_BOOTSTRAP_TIMEOUT_MS,
  type TrayLeaderSummary,
  type TurnIceServer,
  type WorkerToLeaderControlMessage,
} from '@slicc/shared-ts';
import {
  type ApnsProviderTokenSource,
  type ApnsSender,
  apnsConfigFromEnv,
  LocalProviderTokenMinter,
  WebCryptoApnsSender,
} from './apns.js';
import {
  APNS_TOKEN_PATH,
  durableObjectProviderTokenStore,
  handleProviderTokenRequest,
  SharedProviderTokenSource,
} from './apns-provider-token.js';
import { prefersManualRedirect, supersededLinkHeaders, supersededLocation } from './links.js';
import { deletePreviewArchivePrefix } from './persistent-preview-storage.js';
import { previewTokenFromHost } from './preview-host.js';
import { type BiscottoDeps, dispatchBiscottoRoute } from './session-tray-biscotto.js';
import { BootstrapCoordinator, type BootstrapDeps } from './session-tray-bootstrap.js';
import { BRIDGE_WS_TAG, type BridgeDeps, BridgeRelay } from './session-tray-bridge.js';
import {
  dispatchPreviewRoute,
  expirePersistentPreviews,
  failAllPendingPreviews,
  handlePreviewPurge,
  listPreviews as listPreviewsImpl,
  mintPreview as mintPreviewImpl,
  type PreviewAssembler,
  type PreviewDeps,
  type PreviewResponseChunk,
  previewAnnouncementState,
  pushPreviewResponseChunk,
  resolvePreview as resolvePreviewImpl,
  revokePreview as revokePreviewImpl,
} from './session-tray-preview.js';
import { PushCoordinator, type PushDeps } from './session-tray-push.js';
import {
  buildLeaderWebSocketUrl,
  type ControllerAttachRequest,
  isBootstrapRequest,
  type JoinRequest,
  joinRequestControllerId,
  readAttachRequest,
  readJoinRequest,
} from './session-tray-requests.js';
import { type WebhookDeps, WebhookRelay } from './session-tray-webhook.js';
import {
  type CreateTrayRequest,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  FOLLOWER_ATTACH_RETRY_AFTER_MS,
  type JoinCapability,
  jsonResponse,
  type PreviewRecord,
  reclaimMsForTray,
  resolveJoinCapability,
  type TrayRecord,
  type TrayWebSocketLike,
  websocketResponse,
} from './shared.js';
import { timingSafeEqual } from './timing-safe-equal.js';
import { fetchTURNCredentials, TURN_CREDENTIAL_TTL_MS } from './turn-credentials.js';

export interface SessionTrayEnv {
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  PREVIEW_STORAGE?: R2Bucket;
  /** APNs token auth (issue #2062). All four or pushing is disabled. */
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_TOPIC?: string;
  /**
   * This DO's own namespace, used to reach the one instance that mints the
   * APNs provider JWT (see `apns-provider-token.ts`). Absent in unit tests,
   * which fall back to minting locally.
   */
  TRAY_HUB?: DurableObjectNamespaceLike;
}

interface SessionTrayOptions {
  now?: () => number;
  webSocketPairFactory?: () => { client: unknown; server: TrayWebSocketLike };
  fetchImpl?: typeof fetch;
  /** Push sender seam (tests). Defaults to APNs from env, or disabled. */
  apnsSender?: ApnsSender | null;
  /**
   * Override the webhook-delivery ack budget (tests). Defaults to the relay's
   * own production budget; a test with a fake leader that never acks would
   * otherwise sit out the full wait.
   */
  webhookDeliveryWaitMs?: number;
}

const TRAY_STORAGE_KEY = 'tray';
const TURN_CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LEADER_WS_TAG = 'leader';
// Pure-relay leader messages (CDP request relay, preview chunk pumping) only
// bump `leader.lastSeenAt`; persisting the whole tray record on each one would
// be a storage write per CDP command on the hot drive path. Debounce those
// liveness-only writes to at most once per window.
const LEADER_SEEN_PERSIST_MS = 30_000;
// Controllers whose `lastSeenAt` is older than this are pruned. Set to 2×
// the desktop reclaim TTL so a controller always survives a leader reclaim.
const CONTROLLER_STALE_MS = 2 * 60 * 60 * 1000;
// A leader socket that has not sent any application-level message in this
// window is considered "stale" and not reported as connected. This catches
// ghost leaders whose sockets linger after a network drop — workerd's
// setWebSocketAutoResponse keeps responding to pings, but real messages stop.
const LEADER_STALE_MS = 2 * 60 * 1000;

interface CachedIceServers {
  iceServers: TurnIceServer[];
  expiresAtMs: number;
}

const CORS_PREFLIGHT_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export class SessionTrayDurableObject {
  private readonly now: () => number;
  private readonly webSocketPairFactory: () => { client: unknown; server: TrayWebSocketLike };
  private readonly fetchImpl: typeof fetch;
  private readonly turnKeyId: string | undefined;
  private readonly turnApiToken: string | undefined;
  private readonly previewStorage: R2Bucket | undefined;
  private readonly apns: ApnsSender | null;
  /**
   * Local minter, used only when *this* instance is the one serving
   * `APNS_TOKEN_PATH`. Also the fallback if the shared instance is unreachable.
   */
  private readonly apnsTokenMinter: ApnsProviderTokenSource | null;
  private tray: TrayRecord | null = null;
  private leaderSocket: TrayWebSocketLike | null = null;
  private cachedIceServers: CachedIceServers | null = null;
  private autoResponseSet = false;
  // Last time a pure-relay leader message flushed `leader.lastSeenAt` to storage
  // (see LEADER_SEEN_PERSIST_MS). Debounces the hot CDP-relay path.
  private lastLeaderSeenPersistMs = 0;
  // In-flight `/internal/preview/fetch` calls, keyed by reqId. Populated when
  // we send `preview.request` to the leader; drained by `handleLeaderMessage`
  // when the matching `preview.response` arrives (single chunk today, future-
  // proof for chunked binary).
  private readonly pendingPreviews = new Map<string, PreviewAssembler>();

  // Extracted concerns. Each holds only its own state; anything durable lives
  // on the tray record so it survives hibernation.
  private readonly bootstrap: BootstrapCoordinator;
  private readonly bridge: BridgeRelay;
  private readonly webhooks: WebhookRelay;
  private readonly push: PushCoordinator;

  constructor(
    private readonly state: DurableObjectStateLike,
    env: SessionTrayEnv | unknown,
    options: SessionTrayOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
    const typedEnv = (env && typeof env === 'object' ? env : {}) as SessionTrayEnv;
    this.turnKeyId = typedEnv.CLOUDFLARE_TURN_KEY_ID;
    this.turnApiToken = typedEnv.CLOUDFLARE_TURN_API_TOKEN;
    this.previewStorage = typedEnv.PREVIEW_STORAGE;
    const apnsConfig = apnsConfigFromEnv(typedEnv);
    this.apnsTokenMinter = apnsConfig
      ? new LocalProviderTokenMinter(apnsConfig, {
          now: this.now,
          store: durableObjectProviderTokenStore(this.state.storage),
        })
      : null;
    if (options.apnsSender !== undefined) {
      this.apns = options.apnsSender;
    } else if (apnsConfig && this.apnsTokenMinter) {
      // Borrow the JWT from the single minting instance so mint rate stops
      // scaling with tray count × hibernation cycles (issue #2432).
      const tokenSource = typedEnv.TRAY_HUB
        ? new SharedProviderTokenSource(typedEnv.TRAY_HUB, this.now)
        : this.apnsTokenMinter;
      this.apns = new WebCryptoApnsSender(apnsConfig, {
        fetchImpl: this.fetchImpl,
        now: this.now,
        tokenSource,
      });
    } else {
      this.apns = null;
    }
    this.webSocketPairFactory =
      options.webSocketPairFactory ??
      (() => {
        const PairCtor = (globalThis as { WebSocketPair?: new () => { 0: unknown; 1: unknown } })
          .WebSocketPair;
        if (!PairCtor) {
          throw new Error('WebSocketPair is not available in this runtime');
        }
        const pair = new PairCtor();
        return {
          client: pair[0],
          server: pair[1] as TrayWebSocketLike,
        };
      });

    this.bootstrap = new BootstrapCoordinator(this.bootstrapDeps());
    this.bridge = new BridgeRelay(this.bridgeDeps());
    this.webhooks = new WebhookRelay(this.webhookDeps(), options.webhookDeliveryWaitMs);
    this.push = new PushCoordinator(this.pushDeps());
  }

  // ──────────────────────────────────────────────────────────────────────
  // Route dispatch
  // ──────────────────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/internal/create' && request.method === 'POST') {
      return this.handleCreate(request);
    }

    // Served by the one well-known instance every other tray DO borrows from.
    // Handled before loadTray(): that instance owns no tray record.
    if (url.pathname === APNS_TOKEN_PATH) {
      return this.handleApnsTokenRequest(request);
    }

    // Preview routes below dispatch before the general loadTray()/restoreLeaderSocket()
    // call further down, so restore the hibernation-evicted leader socket here first —
    // otherwise a preview fetch arriving right after a DO wake-up sees `leaderSocket`
    // still null and 502s even though the WebSocket is alive in the runtime.
    this.restoreLeaderSocket();

    if (url.pathname.startsWith('/internal/preview/')) {
      const previewRoute = await this.handleInternalPreviewRoute(url, request);
      if (previewRoute) return previewRoute;
    }

    // Bridge WebSocket route — preview-hosted driveable CDP bridge
    if (
      url.pathname === '/__slicc/bridge' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      const hostResult = previewTokenFromHost(url.host);
      if (hostResult) {
        return this.bridge.handleWebSocket(hostResult.token, request);
      }
    }

    await this.loadTray();
    this.restoreLeaderSocket();
    if (!this.tray) {
      return jsonResponse({ error: 'Tray not initialized', code: 'TRAY_NOT_INITIALIZED' }, 500);
    }

    const internal = await this.handleInternalRoute(url, request);
    if (internal) return internal;

    const joinMatch = url.pathname.match(/^\/join\/([^/]+)$/);
    if (joinMatch) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
      }
      const response = await this.handleJoin(request, joinMatch[1], url);
      response.headers.set('access-control-allow-origin', '*');
      return response;
    }

    // Dispatched before the expiry gate, like `/join` above: a superseded tray
    // must answer a delivery with a redirect to its replacement rather than the
    // 410 this gate returns first (#1957). The relay applies the gate itself, so
    // an expired-but-not-superseded tray still answers TRAY_EXPIRED.
    const webhookMatch = url.pathname.match(/^\/webhook\/([^/]+?)(?:\/([^/]+))?$/);
    if (webhookMatch) {
      return this.handleWebhookRoute(request, webhookMatch[1], webhookMatch[2]);
    }

    const expiration = await this.ensureTrayIsActive();
    if (expiration) {
      return expiration;
    }

    const controllerMatch = url.pathname.match(/^\/controller\/([^/]+)$/);
    if (controllerMatch) {
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return this.handleLeaderWebSocket(controllerMatch[1], url);
      }
      return this.handleControllerAttach(request, controllerMatch[1], url);
    }

    return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  private handleWebhookRoute(
    request: Request,
    token: string,
    webhookId: string | undefined
  ): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return Promise.resolve(new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));
    }
    if (request.method !== 'POST') {
      return Promise.resolve(
        jsonResponse({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405, {
          allow: 'POST, OPTIONS',
        })
      );
    }
    return this.webhooks.handle(token, request, webhookId);
  }

  /**
   * Leader-only `/internal/*` control routes reached through the DO stub, i.e.
   * never from the public edge. Grouped into one dispatcher so adding a route
   * costs a line here rather than another branch in `fetch`, which sits at the
   * cognitive-complexity ceiling.
   */
  private async handleInternalRoute(url: URL, request: Request): Promise<Response | null> {
    if (url.pathname === '/internal/supersede' && request.method === 'POST') {
      return this.handleSupersede(request);
    }
    if (url.pathname.startsWith('/internal/biscotto/')) {
      return dispatchBiscottoRoute(url, request, this.biscottoDeps(), (id) =>
        this.announceBiscottoRevocation(id)
      );
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────────────────
  // WebSocket lifecycle
  // ──────────────────────────────────────────────────────────────────────

  async webSocketMessage(ws: TrayWebSocketLike, message: string | ArrayBuffer): Promise<void> {
    if (!this.tray) {
      await this.loadTray();
    }

    // Role-branch: bridge sockets carry preview→leader traffic (CDP responses,
    // events, and window.slicc.emit); the bridge relay owns that half.
    // Everything else is the leader controller WS.
    if (this.tagsFor(ws).includes(BRIDGE_WS_TAG)) {
      await this.bridge.handleMessage(ws, message);
      return;
    }

    this.leaderSocket = ws;
    const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
    await this.handleLeaderMessage(ws, data);
  }

  async webSocketClose(ws: TrayWebSocketLike): Promise<void> {
    if (this.tagsFor(ws).includes(BRIDGE_WS_TAG)) {
      await this.bridge.handleSocketGone(ws);
      return;
    }
    await this.handleLeaderSocketGone(ws);
  }

  async webSocketError(ws: TrayWebSocketLike): Promise<void> {
    // A socket error ends the socket exactly like a close: same bridge/leader
    // teardown, so delegate rather than duplicate.
    await this.webSocketClose(ws);
  }

  // A close/error for the leader socket may be delivered after a newer leader
  // socket has already reconnected (the runtime can deliver these late, and we
  // may be a freshly re-created instance after hibernation). Treat the runtime's
  // getWebSockets(LEADER_WS_TAG) as the source of truth: if another leader
  // socket is still live, the gone socket is stale and must not tear down the
  // tray; otherwise mark the leader disconnected.
  private async handleLeaderSocketGone(ws: TrayWebSocketLike): Promise<void> {
    if (!this.tray) {
      await this.loadTray();
    }
    const liveSockets = this.currentLeaderSockets().filter((socket) => socket !== ws);
    if (liveSockets.length > 0) {
      this.leaderSocket = liveSockets[0] ?? null;
      return;
    }
    this.leaderSocket = ws;
    await this.markLeaderDisconnected(ws);
  }

  private currentLeaderSockets(): TrayWebSocketLike[] {
    if (typeof this.state.getWebSockets !== 'function') {
      return this.leaderSocket ? [this.leaderSocket] : [];
    }
    return this.state.getWebSockets(LEADER_WS_TAG) as TrayWebSocketLike[];
  }

  private restoreLeaderSocket(): void {
    if (this.leaderSocket) {
      return;
    }
    const [socket] = this.currentLeaderSockets();
    if (socket) {
      this.leaderSocket = socket;
    }
  }

  private socketsWithTag(tag: string): TrayWebSocketLike[] {
    return (this.state.getWebSockets?.(tag) ?? []) as TrayWebSocketLike[];
  }

  private tagsFor(ws: TrayWebSocketLike): string[] {
    return this.state.getTags?.(ws) ?? [];
  }

  private ensureWebSocketAutoResponse(): void {
    if (this.autoResponseSet) return;
    if (typeof WebSocketRequestResponsePair !== 'undefined') {
      this.state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('ping', 'pong'));
    }
    this.autoResponseSet = true;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Tray record lifecycle
  // ──────────────────────────────────────────────────────────────────────

  private async handleCreate(request: Request): Promise<Response> {
    const payload = (await request.json()) as CreateTrayRequest;
    if (this.tray) {
      return jsonResponse(this.tray, 200);
    }

    this.tray = {
      trayId: payload.trayId,
      createdAt: payload.createdAt,
      joinToken: payload.joinToken,
      controllerToken: payload.controllerToken,
      webhookToken: payload.webhookToken,
      kind: payload.kind ?? 'desktop',
      controllers: {},
      bootstraps: {},
      leader: null,
    };
    await this.persistTray();
    return jsonResponse(this.tray, 201);
  }

  /**
   * Mark this tray as superseded by a freshly-minted tray's join URL. Called
   * by the leader (via the worker's `POST /api/tray/:trayId/supersede`,
   * Bearer = this tray's controllerToken) right before it abandons this tray
   * for a new one — see `shouldRecreateTray` in the webapp's
   * `tray-leader.ts`. Best-effort: if the leader crashes before this call
   * lands, followers still fall back to the existing TRAY_EXPIRED path once
   * the reclaim TTL elapses.
   */
  private async handleSupersede(request: Request): Promise<Response> {
    const tray = this.requireTray();
    let body: { controllerToken?: string; joinUrl?: string; webhookUrl?: string };
    try {
      body = (await request.json()) as {
        controllerToken?: string;
        joinUrl?: string;
        webhookUrl?: string;
      };
    } catch {
      return jsonResponse({ error: 'Invalid body', code: 'INVALID_BODY' }, 400);
    }
    if (!this.matchesToken(body.controllerToken ?? '', tray.controllerToken)) {
      return jsonResponse(
        { error: 'Invalid controller capability', code: 'INVALID_CONTROLLER_CAPABILITY' },
        403
      );
    }
    if (typeof body.joinUrl !== 'string' || !body.joinUrl) {
      return jsonResponse({ error: 'joinUrl is required', code: 'INVALID_BODY' }, 400);
    }
    try {
      new URL(body.joinUrl);
    } catch {
      return jsonResponse({ error: 'joinUrl must be an absolute URL', code: 'INVALID_BODY' }, 400);
    }
    // `webhookUrl` is optional: a leader that predates it still supersedes the
    // join surface, and the webhook surface keeps its pre-existing 410. An
    // unparseable one is refused rather than stored, so the redirect target can
    // never be a value the DO had to guess at.
    if (body.webhookUrl !== undefined) {
      if (typeof body.webhookUrl !== 'string' || !body.webhookUrl) {
        return jsonResponse(
          { error: 'webhookUrl must be a non-empty string', code: 'INVALID_BODY' },
          400
        );
      }
      try {
        new URL(body.webhookUrl);
      } catch {
        return jsonResponse(
          { error: 'webhookUrl must be an absolute URL', code: 'INVALID_BODY' },
          400
        );
      }
      tray.supersededByWebhookUrl = body.webhookUrl;
    }
    tray.supersededByJoinUrl = body.joinUrl;
    await this.persistTray();
    return jsonResponse(
      {
        trayId: tray.trayId,
        supersededByJoinUrl: tray.supersededByJoinUrl,
        supersededByWebhookUrl: tray.supersededByWebhookUrl,
      },
      200
    );
  }

  private async loadTray(): Promise<void> {
    if (this.tray) {
      return;
    }
    const storedTray = (await this.state.storage.get<TrayRecord>(TRAY_STORAGE_KEY)) ?? null;
    this.tray = storedTray
      ? {
          ...storedTray,
          bootstraps: storedTray.bootstraps ?? {},
        }
      : null;
  }

  private async persistTray(): Promise<void> {
    if (!this.tray) {
      return;
    }
    await this.state.storage.put(TRAY_STORAGE_KEY, this.tray);
  }

  private requireTray(): TrayRecord {
    if (!this.tray) {
      throw new Error('Tray not loaded');
    }
    return this.tray;
  }

  private async ensureTrayIsActive(): Promise<Response | null> {
    const tray = this.requireTray();

    if (tray.expiredAt) {
      return jsonResponse({ error: 'Tray expired', code: 'TRAY_EXPIRED' }, 410);
    }

    if (tray.leader?.connected && !this.leaderSocket) {
      tray.leader.connected = false;
      tray.leader.disconnectedAt ??= this.isoNow();
      await this.persistTray();
    }

    if (!tray.leader?.disconnectedAt || tray.leader.connected) {
      return null;
    }

    const expiresAt = Date.parse(tray.leader.disconnectedAt) + reclaimMsForTray(tray);
    if (this.now() <= expiresAt) {
      return null;
    }

    tray.expiredAt = this.isoNow();
    await this.persistTray();
    return jsonResponse(
      {
        error: 'Tray expired because the leader did not reclaim it in time',
        code: 'TRAY_EXPIRED',
      },
      410
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Join surface (followers and guests)
  // ──────────────────────────────────────────────────────────────────────

  private async handleJoin(request: Request, token: string, url: URL): Promise<Response> {
    const tray = this.requireTray();
    const joinRequest = request.method === 'POST' ? await readJoinRequest(request, url) : null;
    // Single default-deny point for the whole join surface: either the tray's
    // own join token (full follower) or a live biscotto seat (guest). Anything
    // else — including a revoked or expired seat — is an invalid capability.
    const capability = resolveJoinCapability(tray, token, this.now(), (a, b) =>
      this.matchesToken(a, b)
    );
    if (!capability) {
      if (joinRequest) {
        return await this.buildFollowerAttachResponse(
          joinRequestControllerId(joinRequest),
          {
            action: 'fail',
            code: 'INVALID_JOIN_CAPABILITY',
            error: 'Invalid join capability',
          },
          403
        );
      }
      return jsonResponse(
        { error: 'Invalid join capability', code: 'INVALID_JOIN_CAPABILITY' },
        403
      );
    }

    // The leader abandoned this tray in favor of a fresh one (see
    // `/internal/supersede` above) — this tray's leader socket will never
    // reconnect, so point the follower at the replacement instead of leaving
    // it to retry FOLLOWER_JOIN_NOT_READY / TRAY_EXPIRED forever. Checked
    // before the expiry gate: a superseded tray is a more actionable signal
    // than a generic expiry, and supersession can be set before expiry hits.
    if (tray.supersededByJoinUrl) {
      return await this.supersededResponse(tray.supersededByJoinUrl, joinRequest, url);
    }

    const expiration = await this.ensureTrayIsActive();
    if (expiration) {
      if (joinRequest) {
        return await this.buildFollowerAttachResponse(
          joinRequestControllerId(joinRequest),
          {
            action: 'fail',
            code: 'TRAY_EXPIRED',
            error: 'Tray expired because the leader did not reclaim it in time',
          },
          410
        );
      }
      return expiration;
    }

    if (joinRequest) {
      if (isBootstrapRequest(joinRequest)) {
        return this.bootstrap.handleRequest(joinRequest);
      }
      return this.handleFollowerAttach(joinRequest, capability);
    }

    return this.handleJoinProbe(tray);
  }

  /**
   * `GET /join/:token` — the pre-attach probe. Reports whether signaling can
   * begin at all, so a follower does not open a peer connection against a tray
   * whose leader has not connected yet.
   */
  private async handleJoinProbe(tray: TrayRecord): Promise<Response> {
    const payload = {
      trayId: tray.trayId,
      capability: 'join',
      leader: await this.leaderSummary(),
      participantCount: Object.keys(tray.controllers).length,
    };

    if (!tray.leader || !this.hasLiveLeader()) {
      return jsonResponse(
        {
          ...payload,
          error: 'Follower join requires a live leader connection before signaling can begin',
          code: 'FOLLOWER_JOIN_NOT_READY',
          retryable: true,
        },
        409
      );
    }

    return jsonResponse({
      ...payload,
      signaling: {
        transport: 'http-poll',
        actions: ['attach', 'poll', 'answer', 'ice-candidate', 'retry'],
        timeoutMs: TRAY_BOOTSTRAP_TIMEOUT_MS,
        maxRetries: TRAY_BOOTSTRAP_MAX_RETRIES,
        retryAfterMs: TRAY_BOOTSTRAP_RETRY_AFTER_MS,
      },
    });
  }

  /**
   * The redirect that sends a follower to the tray that replaced this one.
   *
   * Step 2 of #1957: `308 Permanent Redirect` + `Location`, because the old
   * tray's leader socket will never reconnect (see `ensureTrayIsActive`) and
   * nothing here is retryable — which is what a 409 claimed for two releases.
   * 308 over 301/302 so the method and body of the attach `POST` survive the
   * hop, and over 307 because the move is permanent.
   *
   * The JSON body and the `successor-version` link both stay: a redirect
   * response may carry a body, the link is what clients persist (it has no
   * `json=true` on it, unlike `Location`), and the `error` string is still the
   * only human-readable account of what happened. Only `result.action` changes,
   * from `fail` to `redirect` — safe because every client that suppresses
   * redirect-following keys off the link or `code` rather than `action`, and
   * every client that does not suppress them never sees this body at all.
   *
   * Two cases keep the pre-#1957 409 `fail` shape. A replacement that does not
   * parse as a URL, because there is no target and a 3xx would be a redirect to
   * nowhere. And a request carrying `?redirect=manual`, because a client that
   * cannot suppress redirect-following needs to be *told* about each hop to
   * count it — see {@link prefersManualRedirect}. Both keep the
   * `successor-version` link, which is all a client needs to follow the hop.
   */
  private async supersededResponse(
    joinUrl: string,
    joinRequest: JoinRequest | null,
    requestUrl: URL
  ): Promise<Response> {
    const error = 'This session moved to a new tray after the leader reconnected';
    const location = prefersManualRedirect(requestUrl)
      ? null
      : supersededLocation(joinUrl, requestUrl);
    const headers = {
      ...supersededLinkHeaders(joinUrl),
      ...(location ? { Location: location } : {}),
    };
    const status = location ? 308 : 409;
    if (joinRequest) {
      return await this.buildFollowerAttachResponse(
        joinRequestControllerId(joinRequest),
        {
          action: location ? 'redirect' : 'fail',
          code: 'TRAY_SUPERSEDED',
          error,
          joinUrl,
        },
        status,
        undefined,
        headers
      );
    }
    return jsonResponse(
      {
        trayId: this.requireTray().trayId,
        capability: 'join',
        error,
        code: 'TRAY_SUPERSEDED',
        joinUrl,
      },
      status,
      headers
    );
  }

  private async handleFollowerAttach(
    attach: ControllerAttachRequest,
    capability: JoinCapability
  ): Promise<Response> {
    try {
      const tray = this.requireTray();
      this.pruneStaleControllers();
      const controllerId = attach.controllerId ?? crypto.randomUUID();
      const biscottoId = capability.trust === 'biscotto' ? capability.biscotto.id : undefined;

      const mismatch = this.recordFollowerController(controllerId, attach.runtime, biscottoId);
      if (mismatch) return mismatch;

      if (capability.trust === 'biscotto') {
        capability.biscotto.lastSeenAt = this.isoNow();
      }

      let iceServers: TurnIceServer[] | undefined;
      const result: FollowerAttachResult = this.hasLiveLeader()
        ? {
            action: 'signal',
            code: 'LEADER_CONNECTED',
            bootstrap: this.bootstrap.buildStatus(
              await this.bootstrap.ensure(controllerId, attach.runtime, biscottoId)
            ),
          }
        : {
            action: 'wait',
            code: tray.leader ? 'LEADER_NOT_CONNECTED' : 'LEADER_NOT_ELECTED',
            retryAfterMs: FOLLOWER_ATTACH_RETRY_AFTER_MS,
          };

      if (result.action === 'signal') {
        iceServers = await this.getIceServers();
      }

      await this.persistTray();

      return await this.buildFollowerAttachResponse(controllerId, result, 200, iceServers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        {
          error: 'Internal error during follower attach',
          code: 'FOLLOWER_ATTACH_ERROR',
          diagnostics: message,
        },
        500
      );
    }
  }

  /**
   * Upsert the controller record for an attaching follower, or return the 409
   * that refuses a replayed `controllerId`.
   *
   * `controllerId` is client-supplied. Trust is always re-derived from the
   * presented token by the caller; this only catches the case where the same
   * id is replayed under a DIFFERENT capability. Rejecting both directions
   * keeps a guest from inheriting a full follower's id (the attack) and a full
   * follower from being shadowed by a guest that guessed its id (the denial).
   */
  private recordFollowerController(
    controllerId: string,
    runtime: string | undefined,
    biscottoId: string | undefined
  ): Response | null {
    const tray = this.requireTray();
    const nowIso = this.isoNow();
    const known = tray.controllers[controllerId];
    if (!known) {
      tray.controllers[controllerId] = {
        controllerId,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        runtime,
        biscottoId,
      };
      return null;
    }
    if (known.biscottoId !== biscottoId) {
      return jsonResponse(
        {
          error: 'Controller id was already attached with a different capability',
          code: 'JOIN_CAPABILITY_MISMATCH',
        },
        409
      );
    }
    known.lastSeenAt = nowIso;
    if (runtime) {
      known.runtime = runtime;
    }
    return null;
  }

  private async buildFollowerAttachResponse(
    controllerId: string,
    result: FollowerAttachResult,
    status = 200,
    iceServers?: TurnIceServer[],
    headers?: HeadersInit
  ): Promise<Response> {
    const tray = this.requireTray();
    const payload: FollowerAttachResponse = {
      trayId: tray.trayId,
      controllerId,
      role: 'follower',
      trust: this.trustForController(controllerId),
      leader: await this.leaderSummary(),
      participantCount: Object.keys(tray.controllers).length,
      result,
    };
    if (iceServers) {
      payload.iceServers = iceServers;
    }
    return jsonResponse(payload, status, headers);
  }

  /**
   * Advisory trust for a follower-facing response body, read back off the
   * controller record stamped at attach time. Purely so a guest page can
   * render itself honestly; the leader never reads this back.
   */
  private trustForController(controllerId: string): FollowerTrust {
    return this.requireTray().controllers[controllerId]?.biscottoId ? 'biscotto' : 'full';
  }

  /**
   * Remove controller entries whose `lastSeenAt` is older than the stale
   * threshold. Never prunes the current leader's controller.
   */
  private pruneStaleControllers(): void {
    const tray = this.requireTray();
    const cutoff = new Date(this.now() - CONTROLLER_STALE_MS).toISOString();
    const leaderControllerId = tray.leader?.controllerId;
    for (const [id, controller] of Object.entries(tray.controllers)) {
      if (id === leaderControllerId) continue;
      if (controller.lastSeenAt < cutoff) {
        delete tray.controllers[id];
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Leader election + controller socket
  // ──────────────────────────────────────────────────────────────────────

  private async handleControllerAttach(
    request: Request,
    token: string,
    url: URL
  ): Promise<Response> {
    const tray = this.requireTray();
    if (!this.matchesToken(token, tray.controllerToken)) {
      return jsonResponse(
        { error: 'Invalid controller capability', code: 'INVALID_CONTROLLER_CAPABILITY' },
        403
      );
    }

    const attach = await readAttachRequest(request, url);
    this.pruneStaleControllers();
    const controllerId = attach.controllerId ?? crypto.randomUUID();
    const nowIso = this.isoNow();

    if (!tray.controllers[controllerId]) {
      tray.controllers[controllerId] = {
        controllerId,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        runtime: attach.runtime,
      };
    } else {
      tray.controllers[controllerId].lastSeenAt = nowIso;
      if (attach.runtime) {
        tray.controllers[controllerId].runtime = attach.runtime;
      }
    }

    let role: 'leader' | 'follower' = 'follower';
    let leaderKey: string | undefined;

    if (!tray.leader) {
      role = 'leader';
      leaderKey = this.createLeaderKey();
      tray.leader = {
        controllerId,
        leaderKey,
        claimedAt: nowIso,
        lastSeenAt: nowIso,
        connected: false,
      };
    } else if (attach.leaderKey === tray.leader.leaderKey) {
      if (tray.leader.connected && tray.leader.controllerId !== controllerId) {
        return jsonResponse(
          { error: 'Leader is already connected', code: 'LEADER_ALREADY_CONNECTED' },
          409
        );
      }
      role = 'leader';
      tray.leader.controllerId = controllerId;
      tray.leader.lastSeenAt = nowIso;
      tray.leader.disconnectedAt = undefined;
      leaderKey = tray.leader.leaderKey;
    } else if (!tray.leader.connected && tray.leader.controllerId === controllerId) {
      return jsonResponse(
        {
          error: 'Leader reclaim requires the previously issued leader key',
          code: 'LEADER_KEY_REQUIRED',
        },
        409
      );
    }

    await this.persistTray();

    return jsonResponse({
      trayId: tray.trayId,
      controllerId,
      role,
      leaderKey,
      leader: await this.leaderSummary(),
      websocket:
        role === 'leader' && leaderKey
          ? { url: buildLeaderWebSocketUrl(url, controllerId, leaderKey) }
          : null,
    });
  }

  private async handleLeaderWebSocket(token: string, url: URL): Promise<Response> {
    const tray = this.requireTray();
    if (!this.matchesToken(token, tray.controllerToken)) {
      return jsonResponse(
        { error: 'Invalid controller capability', code: 'INVALID_CONTROLLER_CAPABILITY' },
        403
      );
    }
    if (!tray.leader) {
      return jsonResponse({ error: 'No leader has been elected', code: 'LEADER_NOT_ELECTED' }, 409);
    }

    const controllerId = url.searchParams.get('controllerId');
    const leaderKey = url.searchParams.get('leaderKey');
    if (!controllerId || !leaderKey) {
      return jsonResponse(
        {
          error: 'controllerId and leaderKey are required for the leader WebSocket',
          code: 'LEADER_WEBSOCKET_AUTH_REQUIRED',
        },
        400
      );
    }
    if (leaderKey !== tray.leader.leaderKey || controllerId !== tray.leader.controllerId) {
      return jsonResponse(
        { error: 'Only the elected leader may open the tray WebSocket', code: 'LEADER_ONLY' },
        403
      );
    }
    if (tray.leader.connected && this.leaderSocket) {
      this.evictSupersededLeaderSocket();
    }

    const { client, server } = this.webSocketPairFactory();
    if (typeof this.state.acceptWebSocket !== 'function') {
      throw new Error('Durable Object runtime does not support WebSocket hibernation');
    }
    // Hibernation API: the runtime evicts the object from memory between
    // messages and delivers them via webSocketMessage/Close/Error, so we are
    // not billed for idle connection time. The leader socket is recovered after
    // eviction via getWebSockets(LEADER_WS_TAG).
    this.ensureWebSocketAutoResponse();
    this.state.acceptWebSocket(server, [LEADER_WS_TAG]);
    this.leaderSocket = server;
    tray.leader.connected = true;
    tray.leader.lastSeenAt = this.isoNow();
    tray.leader.disconnectedAt = undefined;

    await this.persistTray();
    server.send(
      JSON.stringify({
        type: 'leader.connected',
        trayId: tray.trayId,
        controllerId,
      })
    );

    // Rehydrate the leader's per-preview announcement metadata even when no
    // visitor sockets are currently live.
    this.replayPreviewStatesToLeader(server);

    // Replay live bridge connections so a (re)connected leader repopulates its
    // in-memory bridge registry. A leader page reload wipes that map while the
    // DO's bridge sockets stay open — without this, those tabs would be
    // permanently invisible and undriveable until each visitor reloaded.
    this.bridge.replayConnectionsToLeader(server);

    return websocketResponse(client);
  }

  /**
   * Close the socket the rightful leader is replacing.
   *
   * Only reached after the auth check proved this is the ELECTED leader
   * (matching controllerId + leaderKey) reconnecting. A stale `leaderSocket`
   * therefore means the DO is still holding the previous leader connection — a
   * ghost socket whose close never fired (workerd doesn't reliably deliver
   * webSocketClose on a dropped/half-open socket, and a DO eviction can drop it
   * entirely) or a superseded duplicate tab. 409-rejecting the rightful leader
   * here deadlocks its reconnect (it retries the same session, exhausts its
   * attempts, and the follower never gets a tray). Last key-holder wins. A
   * DIFFERENT controller was already 403'd, so this can never kick a leader
   * that holds a different key.
   *
   * Null `this.leaderSocket` BEFORE close() so the stale socket's (possibly
   * synchronous) webSocketClose fires as a no-op — its guard is
   * `socket !== this.leaderSocket`, so it must not still point at the stale
   * socket or it would clear the freshly-accepted leader.
   */
  private evictSupersededLeaderSocket(): void {
    const staleSocket = this.leaderSocket;
    this.leaderSocket = null;
    try {
      staleSocket?.close(1000, 'superseded by leader reconnect');
    } catch {
      // Best-effort — the old socket may already be dead.
    }
  }

  private replayPreviewStatesToLeader(leaderWs: TrayWebSocketLike): void {
    for (const record of Object.values(this.tray?.previews ?? {})) {
      const { quiet, announced } = previewAnnouncementState(record);
      leaderWs.send(
        JSON.stringify({
          type: 'preview.state',
          previewToken: record.previewToken,
          quiet,
          announced,
        })
      );
    }
  }

  private async handleLeaderMessage(socket: TrayWebSocketLike, raw: string): Promise<void> {
    if (socket !== this.leaderSocket || !this.tray?.leader) {
      return;
    }

    try {
      const message = JSON.parse(raw) as LeaderToWorkerControlMessage;
      this.tray.leader.lastSeenAt = this.isoNow();

      // Pure-relay branches mutate only `lastSeenAt`; everything else changes
      // persistent tray state and must flush. Tracked so the hot CDP-relay path
      // doesn't storage.put the whole record per command (see below).
      const persistentMutation = await this.dispatchLeaderMessage(socket, message);

      // Flush real state changes immediately; debounce liveness-only writes so a
      // busy CDP drive loop doesn't storage.put the tray record per command.
      if (persistentMutation) {
        await this.persistTray();
      } else {
        const nowMs = this.now();
        if (nowMs - this.lastLeaderSeenPersistMs >= LEADER_SEEN_PERSIST_MS) {
          this.lastLeaderSeenPersistMs = nowMs;
          await this.persistTray();
        }
      }
    } catch {
      socket.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON' }));
    }
  }

  /**
   * Route one decoded leader control message to the concern that owns it.
   * Returns whether the branch mutated persistent tray state — see
   * {@link handleLeaderMessage} for why that matters.
   */
  private async dispatchLeaderMessage(
    socket: TrayWebSocketLike,
    message: LeaderToWorkerControlMessage
  ): Promise<boolean> {
    switch (message.type) {
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong', trayId: this.requireTray().trayId }));
        return false;
      case 'bootstrap.offer':
        this.bootstrap.onLeaderOffer(socket, message);
        return true;
      case 'bootstrap.ice_candidate':
        this.bootstrap.onLeaderIceCandidate(socket, message);
        return true;
      case 'bootstrap.failed':
        this.bootstrap.onLeaderFailed(socket, message);
        return true;
      case 'preview.response':
        pushPreviewResponseChunk(this.pendingPreviews, message as unknown as PreviewResponseChunk);
        return false;
      case 'preview.state.update': {
        const record = this.tray?.previews?.[message.previewToken];
        if (record) record.announced = message.announced;
        return true;
      }
      case 'preview.purge':
        await handlePreviewPurge(message.previewToken, this.previewDeps());
        return true;
      case 'bridge.cdp.request':
        this.bridge.relayCdpRequest(message);
        return false;
      case 'bridge.close':
        this.bridge.closeConnection(message.connId);
        return false;
      case 'webhook.delivery':
        this.webhooks.settle(message);
        return false;
      case 'push.register':
        this.push.register(message);
        return true;
      case 'push.send':
        await this.push.send(message);
        return false;
      default:
        // Unknown message types still count as leader liveness, but there is
        // nothing to persist.
        return true;
    }
  }

  private async markLeaderDisconnected(socket: TrayWebSocketLike): Promise<void> {
    if (socket !== this.leaderSocket || !this.tray?.leader) {
      return;
    }

    this.leaderSocket = null;
    this.tray.leader.connected = false;
    this.tray.leader.disconnectedAt = this.isoNow();
    this.tray.leader.lastSeenAt = this.tray.leader.disconnectedAt;
    failAllPendingPreviews(this.pendingPreviews);
    await this.persistTray();
  }

  private sendToLeader(message: WorkerToLeaderControlMessage): boolean {
    if (!this.hasLiveLeader() || !this.leaderSocket) {
      return false;
    }

    try {
      this.leaderSocket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private hasLiveLeader(): boolean {
    if (!this.tray?.leader?.connected || !this.leaderSocket) {
      return false;
    }
    // A socket that exists but hasn't sent a message in >LEADER_STALE_MS is
    // likely a ghost — workerd may not have delivered webSocketClose for a
    // dropped connection, and setWebSocketAutoResponse keeps the socket
    // looking "alive" at the ping/pong layer.
    const lastSeenMs = Date.parse(this.tray.leader.lastSeenAt);
    return this.now() - lastSeenMs < LEADER_STALE_MS;
  }

  /**
   * Detects a stale leader (socket exists but no messages in >LEADER_STALE_MS)
   * and transitions it to the disconnected state, starting the reclaim TTL.
   * This ensures followers don't receive LEADER_NOT_CONNECTED indefinitely.
   */
  private async evictStaleLeaderIfNeeded(): Promise<void> {
    if (!this.tray?.leader?.connected || !this.leaderSocket) {
      return;
    }
    const lastSeenMs = Date.parse(this.tray.leader.lastSeenAt);
    if (this.now() - lastSeenMs < LEADER_STALE_MS) {
      return;
    }
    // Leader is stale — close the ghost socket and mark disconnected so the
    // reclaim TTL starts. The rightful leader can still reconnect via
    // last-key-holder-wins.
    const staleSocket = this.leaderSocket;
    this.leaderSocket = null;
    this.tray.leader.connected = false;
    this.tray.leader.disconnectedAt = this.isoNow();
    failAllPendingPreviews(this.pendingPreviews);
    await this.persistTray();
    try {
      staleSocket.close(1000, 'leader stale — no messages in >2 min');
    } catch {
      // Best-effort — the socket may already be dead.
    }
  }

  private async leaderSummary(): Promise<TrayLeaderSummary | null> {
    const leader = this.requireTray().leader;
    if (!leader) {
      return null;
    }

    // Evict stale leaders before computing the summary so the reclaim TTL starts.
    await this.evictStaleLeaderIfNeeded();

    return {
      controllerId: leader.controllerId,
      connected: this.hasLiveLeader(),
      reconnectDeadline: leader.disconnectedAt
        ? new Date(Date.parse(leader.disconnectedAt) + reclaimMsForTray(this.tray)).toISOString()
        : null,
      lastSeenAt: leader.lastSeenAt,
    };
  }

  private createLeaderKey(): string {
    return crypto.randomUUID();
  }

  // ──────────────────────────────────────────────────────────────────────
  // Shared primitives
  // ──────────────────────────────────────────────────────────────────────

  private matchesToken(received: string, expected: string): boolean {
    return timingSafeEqual(received, expected);
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private async getIceServers(): Promise<TurnIceServer[] | undefined> {
    if (!this.turnKeyId || !this.turnApiToken) {
      return undefined;
    }

    const now = this.now();
    if (this.cachedIceServers && now < this.cachedIceServers.expiresAtMs) {
      return this.cachedIceServers.iceServers;
    }

    try {
      const iceServers = await fetchTURNCredentials(
        this.turnKeyId,
        this.turnApiToken,
        this.fetchImpl
      );
      this.cachedIceServers = {
        iceServers,
        expiresAtMs:
          this.now() + Math.max(0, TURN_CREDENTIAL_TTL_MS - TURN_CREDENTIAL_REFRESH_MARGIN_MS),
      };
      return iceServers;
    } catch {
      return undefined;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Push (APNs)
  // ──────────────────────────────────────────────────────────────────────

  /** Mint-or-serve the shared APNs provider JWT. See `apns-provider-token.ts`. */
  private handleApnsTokenRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Promise.resolve(jsonResponse({ error: 'Method not allowed' }, 405));
    }
    if (!this.apnsTokenMinter) {
      return Promise.resolve(
        jsonResponse({ error: 'APNs is not configured', code: 'APNS_NOT_CONFIGURED' }, 503)
      );
    }
    return handleProviderTokenRequest(request, this.apnsTokenMinter);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Previews
  // ──────────────────────────────────────────────────────────────────────

  private async handleInternalPreviewRoute(url: URL, request: Request): Promise<Response | null> {
    // For the stop route, we need to close bridge sockets after the preview is revoked.
    // dispatchPreviewRoute consumes request.json(), so clone it first to extract previewToken.
    if (url.pathname === '/internal/preview/stop' && request.method === 'POST') {
      let previewToken: string | undefined;
      try {
        const cloned = request.clone();
        const body = (await cloned.json()) as { previewToken?: string };
        previewToken = body.previewToken;
      } catch {
        // Fall through to dispatchPreviewRoute — it will handle the malformed body
      }
      const response = await dispatchPreviewRoute(url, request, this.previewDeps());
      if (response && response.status === 200 && previewToken) {
        this.bridge.closeSocketsForPreview(previewToken);
      }
      return response;
    }
    return dispatchPreviewRoute(url, request, this.previewDeps());
  }

  async mintPreview(req: {
    controllerToken: string;
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
    workerBaseUrl: string;
    quiet?: boolean;
    ttlMs?: number;
  }): Promise<{ previewToken: string; url: string; uploadToken?: string }> {
    return mintPreviewImpl(req, this.previewDeps());
  }

  async resolvePreview(previewToken: string): Promise<PreviewRecord | null> {
    return resolvePreviewImpl(previewToken, this.previewDeps());
  }

  async revokePreview(previewToken: string): Promise<{ revoked: boolean }> {
    return revokePreviewImpl(previewToken, this.previewDeps());
  }

  async listPreviews(): Promise<PreviewRecord[]> {
    return listPreviewsImpl(this.previewDeps());
  }

  async alarm(): Promise<void> {
    await expirePersistentPreviews(this.previewDeps());
  }

  // ──────────────────────────────────────────────────────────────────────
  // Biscotti (guest seats)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Tell the leader to evict a guest whose seat was just revoked, reporting
   * whether the message landed. Only the leader holds the guest's data
   * channel, so this DO cannot end a live session on its own.
   */
  private announceBiscottoRevocation(biscottoId: string): boolean {
    return this.sendToLeader({
      type: 'biscotto.revoked',
      trayId: this.requireTray().trayId,
      biscottoId,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Dependency seams
  // ──────────────────────────────────────────────────────────────────────

  private bootstrapDeps(): BootstrapDeps {
    return {
      requireTray: () => this.requireTray(),
      persistTray: () => this.persistTray(),
      now: () => this.now(),
      isoNow: () => this.isoNow(),
      hasLiveLeader: () => this.hasLiveLeader(),
      sendToLeader: (msg) => this.sendToLeader(msg),
      getIceServers: () => this.getIceServers(),
      leaderSummary: () => this.leaderSummary(),
    };
  }

  private bridgeDeps(): BridgeDeps {
    return {
      socketsWithTag: (tag) => this.socketsWithTag(tag),
      tagsFor: (ws) => this.tagsFor(ws),
      acceptWebSocket: (ws, tags) => {
        if (typeof this.state.acceptWebSocket !== 'function') {
          throw new Error('Durable Object runtime does not support WebSocket hibernation');
        }
        this.state.acceptWebSocket(ws, tags);
      },
      newWebSocketPair: () => this.webSocketPairFactory(),
      ensureAutoResponse: () => this.ensureWebSocketAutoResponse(),
      loadTray: () => this.loadTray(),
      restoreLeaderSocket: () => this.restoreLeaderSocket(),
      getTray: () => this.tray,
      sendToLeader: (msg) => this.sendToLeader(msg),
      resolvePreview: (token) => this.resolvePreview(token),
      isoNow: () => this.isoNow(),
      now: () => this.now(),
    };
  }

  private webhookDeps(): WebhookDeps {
    return {
      requireTray: () => this.requireTray(),
      matchesToken: (r, e) => this.matchesToken(r, e),
      hasLiveLeader: () => this.hasLiveLeader(),
      sendToLeader: (msg) => this.sendToLeader(msg as WorkerToLeaderControlMessage),
      isoNow: () => this.isoNow(),
      now: () => this.now(),
      ensureTrayIsActive: () => this.ensureTrayIsActive(),
    };
  }

  private pushDeps(): PushDeps {
    return {
      requireTray: () => this.requireTray(),
      persistTray: () => this.persistTray(),
      isoNow: () => this.isoNow(),
      apns: this.apns,
    };
  }

  private previewDeps(): PreviewDeps {
    return {
      loadTray: () => this.loadTray(),
      getTray: () => this.tray,
      persistTray: () => this.persistTray(),
      isoNow: () => this.isoNow(),
      hasLiveLeader: () => this.hasLiveLeader(),
      sendToLeader: (msg) => this.sendToLeader(msg as WorkerToLeaderControlMessage),
      matchesToken: (r, e) => this.matchesToken(r, e),
      pendingPreviews: this.pendingPreviews,
      now: () => this.now(),
      archiveAvailable: () => this.previewStorage !== undefined,
      deleteArchivePrefix: async (prefix) => {
        if (!this.previewStorage) throw new Error('persistent preview storage unavailable');
        await deletePreviewArchivePrefix(this.previewStorage, prefix);
      },
      scheduleExpiry: async (timestamp) => {
        if (timestamp === null) {
          await this.state.storage.deleteAlarm?.();
        } else {
          await this.state.storage.setAlarm?.(timestamp);
        }
      },
    };
  }

  private biscottoDeps(): BiscottoDeps {
    return {
      loadTray: () => this.loadTray(),
      getTray: () => this.tray,
      persistTray: () => this.persistTray(),
      isoNow: () => this.isoNow(),
      now: () => this.now(),
      matchesToken: (r, e) => this.matchesToken(r, e),
    };
  }
}
