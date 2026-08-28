import {
  type CDPPayload,
  type FollowerAttachResponse,
  type FollowerAttachResult,
  type FollowerBiscottoIdentity,
  type FollowerBootstrapRequest,
  type FollowerBootstrapResponse,
  type FollowerTrust,
  type LeaderBridgeCdpRequest,
  type LeaderToWorkerControlMessage,
  type LeaderWebhookDelivery,
  TRAY_BOOTSTRAP_MAX_RETRIES,
  TRAY_BOOTSTRAP_RETRY_AFTER_MS,
  TRAY_BOOTSTRAP_TIMEOUT_MS,
  type TrayBootstrapEvent,
  type TrayBootstrapFailure,
  type TrayBootstrapStatus,
  type TrayIceCandidate,
  type TrayLeaderSummary,
  type TraySessionDescription,
  type TurnIceServer,
  type WebhookDeliveryDisposition,
  type WorkerToLeaderControlMessage,
} from '@slicc/shared-ts';
import {
  type ApnsProviderTokenSource,
  type ApnsPushResult,
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
import { supersededLinkHeaders } from './links.js';
import { deletePreviewArchivePrefix } from './persistent-preview-storage.js';
import { previewTokenFromHost } from './preview-host.js';
import {
  type BiscottoDeps,
  BiscottoRouteError,
  listBiscotti as listBiscottiImpl,
  mintBiscotto as mintBiscottoImpl,
  revokeBiscotto as revokeBiscottoImpl,
} from './session-tray-biscotto.js';
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
import {
  type BiscottoGates,
  type CreateTrayRequest,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  FOLLOWER_ATTACH_RETRY_AFTER_MS,
  type JoinCapability,
  jsonResponse,
  normalizeBiscottoGate,
  type PreviewRecord,
  reclaimMsForTray,
  resolveJoinCapability,
  type TrayBootstrapRecord,
  type TrayRecord,
  type TrayWebSocketLike,
  websocketResponse,
} from './shared.js';
import { timingSafeEqual } from './timing-safe-equal.js';
import { fetchTURNCredentials, TURN_CREDENTIAL_TTL_MS } from './turn-credentials.js';

interface ControllerAttachRequest {
  controllerId?: string;
  leaderKey?: string;
  runtime?: string;
}

type JoinRequest = ControllerAttachRequest | FollowerBootstrapRequest;

type TrayBootstrapEventInput =
  | { type: 'bootstrap.offer'; offer: TraySessionDescription }
  | { type: 'bootstrap.ice_candidate'; candidate: TrayIceCandidate }
  | { type: 'bootstrap.failed'; failure: TrayBootstrapFailure };

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
   * Override the webhook-delivery ack budget (tests). Defaults to
   * {@link WEBHOOK_DELIVERY_WAIT_MS}; a test with a fake leader that never acks
   * would otherwise sit out the full production budget.
   */
  webhookDeliveryWaitMs?: number;
}

/** Loosely-typed follower bootstrap POST body; every field is re-validated below. */
interface FollowerBootstrapBody {
  action?: unknown;
  controllerId?: unknown;
  bootstrapId?: unknown;
  runtime?: unknown;
  cursor?: unknown;
  answer?: unknown;
  candidate?: unknown;
}

/** Cap on registered push devices per tray; oldest registrations are evicted. */
const MAX_PUSH_TOKENS_PER_TRAY = 16;

const TRAY_STORAGE_KEY = 'tray';
const TURN_CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LEADER_WS_TAG = 'leader';
const BRIDGE_WS_TAG = 'bridge';
// Untrusted `window.slicc.emit()` frames arrive over the bridge WS and are
// forwarded verbatim into the cone's context. Bound both the per-frame size and
// the per-connection rate so a hostile preview visitor can't flood the agent
// with attacker-controlled text (token DoS / prompt-injection amplifier). The
// counter is per live DO instance — good enough because an active flood keeps
// the DO awake, and an idle reset between floods is harmless.
const MAX_BRIDGE_EMIT_BYTES = 16 * 1024;
const BRIDGE_EMIT_WINDOW_MS = 10_000;
const MAX_BRIDGE_EMITS_PER_WINDOW = 20;
// Pure-relay leader messages (CDP request relay, preview chunk pumping) only
// bump `leader.lastSeenAt`; persisting the whole tray record on each one would
// be a storage write per CDP command on the hot drive path. Debounce those
// liveness-only writes to at most once per window.
const LEADER_SEEN_PERSIST_MS = 30_000;
// Grace period after a bootstrap reaches a terminal state before it is pruned.
// Gives the follower time to poll the final failure before the record vanishes.
const BOOTSTRAP_TERMINAL_GRACE_MS = 5 * 60 * 1000;
// Maximum bootstrap events kept per record. The follower polls via a cursor so
// only recent events matter; old SDP payloads (kilobytes each) are dropped.
const MAX_BOOTSTRAP_EVENTS = 20;
// Controllers whose `lastSeenAt` is older than this are pruned. Set to 2×
// the desktop reclaim TTL so a controller always survives a leader reclaim.
const CONTROLLER_STALE_MS = 2 * 60 * 60 * 1000;
// A leader socket that has not sent any application-level message in this
// window is considered "stale" and not reported as connected. This catches
// ghost leaders whose sockets linger after a network drop — workerd's
// setWebSocketAutoResponse keeps responding to pings, but real messages stop.
const LEADER_STALE_MS = 2 * 60 * 1000;
// How long a webhook POST waits for the leader's `webhook.delivery` before the
// receipt falls back to the pre-#2524 `202 accepted` (issue #2524). Short on
// purpose: the leader's answer is synchronous once the message lands, and the
// caller is an external service on a request budget of its own.
const WEBHOOK_DELIVERY_WAIT_MS = 3_000;

/**
 * Turn the leader's disposition into the webhook POST's receipt. `delivered`,
 * `filtered` and "no answer" all keep the pre-#2524 `202 accepted` — a
 * `--filter` dropping an event is the filter doing its job, and silence is not
 * evidence of a drop. The other two used to be reported as success too, which
 * made a black-holed webhook indistinguishable from a healthy one.
 */
function webhookDeliveryResponse(
  webhookId: string,
  disposition: WebhookDeliveryDisposition | null
): Response {
  const cors = { 'access-control-allow-origin': '*' };
  if (disposition === 'unknown-webhook') {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: `Webhook "${webhookId}" is not registered with this leader`,
        code: 'WEBHOOK_NOT_REGISTERED',
      },
      404,
      cors
    );
  }
  if (disposition === 'unresolved-target') {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: `Webhook "${webhookId}" targets a scoop or cone that does not exist — the event was dropped`,
        code: 'WEBHOOK_TARGET_UNRESOLVED',
      },
      422,
      cors
    );
  }
  return jsonResponse({ ok: true, accepted: true }, 202, cors);
}

interface CachedIceServers {
  iceServers: TurnIceServer[];
  expiresAtMs: number;
}

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
  private apnsDisabledLogged = false;
  private tray: TrayRecord | null = null;
  private leaderSocket: TrayWebSocketLike | null = null;
  private cachedIceServers: CachedIceServers | null = null;
  private autoResponseSet = false;
  // Per-bridge-connection emit rate-limiter (fixed window), keyed by connId.
  // Evicted when the bridge socket closes/errors.
  private readonly bridgeEmitWindows = new Map<string, { windowStart: number; count: number }>();
  // Last time a pure-relay leader message flushed `leader.lastSeenAt` to storage
  // (see LEADER_SEEN_PERSIST_MS). Debounces the hot CDP-relay path.
  private lastLeaderSeenPersistMs = 0;
  // In-flight `/internal/preview/fetch` calls, keyed by reqId. Populated when
  // we send `preview.request` to the leader; drained by `handleLeaderMessage`
  // when the matching `preview.response` arrives (single chunk today, future-
  // proof for chunked binary).
  private readonly pendingPreviews = new Map<string, PreviewAssembler>();
  // Webhook POSTs whose HTTP response is waiting on the leader's disposition
  // (issue #2524), keyed by deliveryId. Populated by `handleWebhook`; drained by
  // `handleLeaderMessage` on `webhook.delivery`, or by the wait budget.
  private readonly pendingWebhookDeliveries = new Map<
    string,
    (disposition: WebhookDeliveryDisposition | null) => void
  >();
  private webhookDeliveryCounter = 0;
  private readonly webhookDeliveryWaitMs: number;

  constructor(
    private readonly state: DurableObjectStateLike,
    env: SessionTrayEnv | unknown,
    options: SessionTrayOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webhookDeliveryWaitMs = options.webhookDeliveryWaitMs ?? WEBHOOK_DELIVERY_WAIT_MS;
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
  }

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
        return this.handleBridgeWebSocket(hostResult.token, request);
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
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
          },
        });
      }
      const response = await this.handleJoin(request, joinMatch[1], url);
      response.headers.set('access-control-allow-origin', '*');
      return response;
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

    const webhookMatch = url.pathname.match(/^\/webhook\/([^/]+?)(?:\/([^/]+))?$/);
    if (webhookMatch) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
          },
        });
      }
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405, {
          allow: 'POST, OPTIONS',
        });
      }
      return this.handleWebhook(webhookMatch[1], request, webhookMatch[2]);
    }

    return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  async webSocketMessage(ws: TrayWebSocketLike, message: string | ArrayBuffer): Promise<void> {
    if (!this.tray) {
      await this.loadTray();
    }

    // Role-branch: bridge sockets carry preview→leader traffic (CDP responses,
    // events, and window.slicc.emit); dispatch them in a dedicated method so
    // this handler stays simple. Everything else is the leader controller WS.
    const tags = this.state.getTags?.(ws) ?? [];
    if (tags.includes(BRIDGE_WS_TAG)) {
      await this.handleBridgeMessage(ws, message);
      return;
    }

    // Leader socket: existing handler
    this.leaderSocket = ws;
    const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
    await this.handleLeaderMessage(ws, data);
  }

  /**
   * Handle an inbound message on a bridge socket (a driveable-preview visitor
   * tab). Parses defensively (untrusted third-party traffic) and relays CDP
   * responses/events + attributed `window.slicc.emit()` events to the leader.
   * Extracted from `webSocketMessage` to keep that dispatcher under the
   * cognitive-complexity gate.
   */
  private async handleBridgeMessage(
    ws: TrayWebSocketLike,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (!this.tray) {
      await this.loadTray();
    }
    this.restoreLeaderSocket();
    const { connId, previewToken } = (ws.deserializeAttachment?.() ?? {}) as {
      connId?: string;
      previewToken?: string;
    };
    // The attachment must carry the connId (set at accept time); without it we
    // can't route the frame back to the right leader-side transport. Drop it.
    if (!connId) return;
    const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
    // Bridge sockets carry UNTRUSTED third-party visitor-tab traffic. A
    // malformed / non-JSON frame must not throw out of this hibernatable handler
    // (that would reset the DO and drop the tray). Silently drop invalid frames.
    let msg: {
      t?: string;
      id: number;
      result?: CDPPayload;
      error?: { code: number; message: string };
      name?: string;
      detail?: unknown;
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.t === 'cdp.res') {
      this.sendToLeader({
        type: 'bridge.cdp.response',
        connId,
        id: msg.id,
        result: msg.result,
        error: msg.error,
      });
    } else if (msg.t === 'emit') {
      // window.slicc.emit() over the bridge WS. The DO knows the origin
      // connection (connId + previewToken from the socket attachment), so it
      // ATTRIBUTES the event: routed as the record's webhook.event with the
      // preview identity in headers, so the cone knows which tab fired it (the
      // matching drive target is `preview:<token>:<connId>`) and can tell a
      // preview event apart from a plain webhook. Unattributed beacon emits (the
      // page-unload fallback) go through handlePreviewEmit instead.
      //
      // Bound size + rate first: this is untrusted third-party traffic that
      // lands verbatim in the agent's context.
      if (data.length > MAX_BRIDGE_EMIT_BYTES) {
        console.warn('[bridge] emit dropped: payload too large', {
          connId,
          previewToken,
          bytes: data.length,
        });
        return;
      }
      if (!this.allowBridgeEmit(connId)) {
        console.warn('[bridge] emit dropped: rate limit exceeded', { connId, previewToken });
        return;
      }
      const record = previewToken ? this.tray?.previews?.[previewToken] : undefined;
      if (record?.webhookId) {
        const delivered = this.sendToLeader({
          type: 'webhook.event',
          webhookId: record.webhookId,
          headers: {
            'x-slicc-preview-conn': connId,
            'x-slicc-preview-token': previewToken ?? '',
          },
          body: { name: msg.name, detail: msg.detail },
          timestamp: new Date(this.now()).toISOString(),
        });
        // A WS frame has no response channel, so unlike the beacon path (which
        // returns 502) we can't signal the page. Log the drop — this is the only
        // trace when a live leader momentarily vanishes mid-session.
        if (!delivered) {
          console.warn('[bridge] emit dropped: no live leader', { connId, previewToken });
        }
      } else {
        // No webhook to route to: the preview was revoked mid-flight (revoke
        // deletes the webhook and closes sockets, but an in-flight frame can still
        // arrive) or was never bridged with a provisioned webhook. The sibling
        // beacon path returns 400 here; a WS frame can only be logged.
        console.warn('[bridge] emit dropped: preview has no webhookId', {
          connId,
          previewToken,
          hasRecord: Boolean(record),
        });
      }
    }
  }

  /**
   * Fixed-window rate limit for `window.slicc.emit()` frames from one bridge
   * connection. Returns false (drop) once a connection exceeds
   * MAX_BRIDGE_EMITS_PER_WINDOW within BRIDGE_EMIT_WINDOW_MS.
   */
  private allowBridgeEmit(connId: string): boolean {
    const now = this.now();
    const win = this.bridgeEmitWindows.get(connId);
    if (!win || now - win.windowStart >= BRIDGE_EMIT_WINDOW_MS) {
      this.bridgeEmitWindows.set(connId, { windowStart: now, count: 1 });
      return true;
    }
    if (win.count >= MAX_BRIDGE_EMITS_PER_WINDOW) return false;
    win.count += 1;
    return true;
  }

  async webSocketClose(ws: TrayWebSocketLike): Promise<void> {
    const tags = this.state.getTags?.(ws) ?? [];
    if (tags.includes(BRIDGE_WS_TAG)) {
      await this.handleBridgeSocketGone(ws);
      return;
    }
    // Leader socket: existing handler
    await this.handleLeaderSocketGone(ws);
  }

  async webSocketError(ws: TrayWebSocketLike): Promise<void> {
    // A socket error ends the socket exactly like a close: same bridge/leader
    // teardown, so delegate rather than duplicate.
    await this.webSocketClose(ws);
  }

  /**
   * A bridge visitor socket ended (close or error). Notify the leader so it
   * drops the phantom `preview:` target, and evict the per-conn emit-rate window.
   */
  private async handleBridgeSocketGone(ws: TrayWebSocketLike): Promise<void> {
    if (!this.tray) {
      await this.loadTray();
    }
    this.restoreLeaderSocket();
    const { connId } = (ws.deserializeAttachment?.() ?? {}) as { connId?: string };
    if (connId) {
      this.bridgeEmitWindows.delete(connId);
      this.sendToLeader({ type: 'bridge.disconnected', connId });
    }
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
    let body: { controllerToken?: string; joinUrl?: string };
    try {
      body = (await request.json()) as { controllerToken?: string; joinUrl?: string };
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
    tray.supersededByJoinUrl = body.joinUrl;
    await this.persistTray();
    return jsonResponse(
      { trayId: tray.trayId, supersededByJoinUrl: tray.supersededByJoinUrl },
      200
    );
  }

  private async handleJoin(request: Request, token: string, url: URL): Promise<Response> {
    const tray = this.requireTray();
    const joinRequest = request.method === 'POST' ? await this.readJoinRequest(request, url) : null;
    // Single default-deny point for the whole join surface: either the tray's
    // own join token (full follower) or a live biscotto seat (guest). Anything
    // else — including a revoked or expired seat — is an invalid capability.
    const capability = resolveJoinCapability(tray, token, this.now(), (a, b) =>
      this.matchesToken(a, b)
    );
    if (!capability) {
      if (joinRequest) {
        return await this.buildFollowerAttachResponse(
          this.getJoinRequestControllerId(joinRequest),
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
    // `/internal/supersede` below) — this tray's leader socket will never
    // reconnect, so point the follower at the replacement instead of leaving
    // it to retry FOLLOWER_JOIN_NOT_READY / TRAY_EXPIRED forever. Checked
    // before the expiry gate: a superseded tray is a more actionable signal
    // than a generic expiry, and supersession can be set before expiry hits.
    if (tray.supersededByJoinUrl) {
      const joinUrl = tray.supersededByJoinUrl;
      const error = 'This session moved to a new tray after the leader reconnected';
      // Step 1 of #1957: the status and body stay exactly as shipped clients
      // parse them; the RFC 5829 `successor-version` link is the additive
      // machine-readable form of the same redirect. Clients that don't know
      // the rel ignore the header.
      const linkHeaders = supersededLinkHeaders(joinUrl);
      if (joinRequest) {
        return await this.buildFollowerAttachResponse(
          this.getJoinRequestControllerId(joinRequest),
          { action: 'fail', code: 'TRAY_SUPERSEDED', error, joinUrl },
          409,
          undefined,
          linkHeaders
        );
      }
      return jsonResponse(
        {
          trayId: tray.trayId,
          capability: 'join',
          error,
          code: 'TRAY_SUPERSEDED',
          joinUrl,
        },
        409,
        linkHeaders
      );
    }

    const expiration = await this.ensureTrayIsActive();
    if (expiration) {
      if (joinRequest) {
        return await this.buildFollowerAttachResponse(
          this.getJoinRequestControllerId(joinRequest),
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
      if (this.isBootstrapRequest(joinRequest)) {
        return this.handleBootstrapRequest(joinRequest);
      }
      return this.handleFollowerAttach(joinRequest, capability);
    }

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

  private async handleFollowerAttach(
    attach: ControllerAttachRequest,
    capability: JoinCapability
  ): Promise<Response> {
    try {
      const tray = this.requireTray();
      this.pruneStaleControllers();
      const controllerId = attach.controllerId ?? crypto.randomUUID();
      const nowIso = this.isoNow();
      const biscottoId = capability.trust === 'biscotto' ? capability.biscotto.id : undefined;

      if (!tray.controllers[controllerId]) {
        tray.controllers[controllerId] = {
          controllerId,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          runtime: attach.runtime,
          biscottoId,
        };
      } else {
        const known = tray.controllers[controllerId];
        // `controllerId` is client-supplied. Trust is always re-derived from
        // the presented token above; this only catches the case where the same
        // id is replayed under a DIFFERENT capability. Rejecting both
        // directions keeps a guest from inheriting a full follower's id (the
        // attack) and a full follower from being shadowed by a guest that
        // guessed its id (the denial).
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
        if (attach.runtime) {
          known.runtime = attach.runtime;
        }
      }

      if (capability.trust === 'biscotto') {
        capability.biscotto.lastSeenAt = nowIso;
      }

      let iceServers: TurnIceServer[] | undefined;
      const result: FollowerAttachResult = this.hasLiveLeader()
        ? {
            action: 'signal',
            code: 'LEADER_CONNECTED',
            bootstrap: this.buildBootstrapStatus(
              await this.ensureBootstrap(controllerId, attach.runtime, biscottoId)
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

  private async handleBootstrapRequest(request: FollowerBootstrapRequest): Promise<Response> {
    switch (request.action) {
      case 'poll':
        return this.handleBootstrapPoll(
          request.controllerId,
          request.bootstrapId,
          request.cursor ?? 0
        );
      case 'answer':
        return this.handleBootstrapAnswer(
          request.controllerId,
          request.bootstrapId,
          request.answer
        );
      case 'ice-candidate':
        return this.handleBootstrapIceCandidate(
          request.controllerId,
          request.bootstrapId,
          request.candidate
        );
      case 'retry':
        return this.handleBootstrapRetry(
          request.controllerId,
          request.bootstrapId,
          request.runtime
        );
      default:
        return jsonResponse(
          { error: 'Invalid bootstrap request', code: 'INVALID_BOOTSTRAP_REQUEST' },
          400
        );
    }
  }

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

    const attach = await this.readAttachRequest(request, url);
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
          ? {
              url: this.buildLeaderWebSocketUrl(url, controllerId, leaderKey),
            }
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
      // We only reach here after the auth check above proved this is the
      // ELECTED leader (matching controllerId + leaderKey) reconnecting. A
      // stale `leaderSocket` therefore means the DO is still holding the
      // previous leader connection — a ghost socket whose close never fired
      // (workerd doesn't reliably deliver webSocketClose on a dropped/half-open
      // socket, and a DO eviction can drop it entirely) or a superseded
      // duplicate tab. 409-rejecting the rightful leader here deadlocks its
      // reconnect (it retries the same session, exhausts its attempts, and the
      // follower never gets a tray). Last key-holder wins: close the old socket
      // and accept the new one. A DIFFERENT controller was already 403'd above,
      // so this can never kick a leader that holds a different key.
      // Null `this.leaderSocket` BEFORE close() so the stale socket's
      // (possibly synchronous) webSocketClose fires as a no-op — its guard is
      // `socket !== this.leaderSocket`, so it must not still point at the stale
      // socket or it would clear the freshly-accepted leader below.
      const staleSocket = this.leaderSocket;
      this.leaderSocket = null;
      try {
        staleSocket.close(1000, 'superseded by leader reconnect');
      } catch {
        // Best-effort — the old socket may already be dead.
      }
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
    this.replayBridgeConnectionsToLeader(server);

    return websocketResponse(client);
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

  /**
   * Send a `bridge.connected` for every live bridge socket to a specific leader
   * socket. Metadata comes from the socket attachment stamped at accept time
   * (connId / previewToken / origin / userAgent / connectedAt).
   */
  private replayBridgeConnectionsToLeader(leaderWs: TrayWebSocketLike): void {
    const bridgeSockets = (this.state.getWebSockets?.(BRIDGE_WS_TAG) ?? []) as TrayWebSocketLike[];
    for (const ws of bridgeSockets) {
      const att = (ws.deserializeAttachment?.() ?? {}) as {
        connId?: string;
        previewToken?: string;
        origin?: string;
        userAgent?: string;
        connectedAt?: string;
      };
      if (!att.connId || !att.previewToken) continue;
      leaderWs.send(
        JSON.stringify({
          type: 'bridge.connected',
          connId: att.connId,
          previewToken: att.previewToken,
          origin: att.origin ?? '',
          userAgent: att.userAgent ?? '',
          connectedAt: att.connectedAt ?? this.isoNow(),
          replay: true,
        })
      );
    }
  }

  private async handleBridgeWebSocket(previewToken: string, request: Request): Promise<Response> {
    const record = await this.resolvePreview(previewToken);
    if (!record?.bridge) {
      return jsonResponse({ error: 'Bridge not enabled', code: 'BRIDGE_DISABLED' }, 403);
    }
    const existing = (this.state.getWebSockets?.(BRIDGE_WS_TAG) ?? []).filter((w) =>
      this.state.getTags?.(w)?.includes(`tok:${previewToken}`)
    );
    if (existing.length >= (record.maxTabs ?? 20)) {
      return jsonResponse({ error: 'Too many bridged tabs', code: 'BRIDGE_CAP' }, 429);
    }
    const { client, server } = this.webSocketPairFactory();
    const connId = crypto.randomUUID();
    this.state.acceptWebSocket!(server, [BRIDGE_WS_TAG, `tok:${previewToken}`, `conn:${connId}`]);
    const origin = request.headers.get('origin') ?? '';
    const userAgent = request.headers.get('user-agent') ?? '';
    const connectedAt = this.isoNow();
    server.serializeAttachment?.({ connId, previewToken, origin, userAgent, connectedAt });
    this.ensureWebSocketAutoResponse();
    server.send(JSON.stringify({ t: 'welcome', connId }));
    // Ensure tray and leader socket are available before sending notification
    await this.loadTray();
    this.restoreLeaderSocket();
    this.sendToLeader({
      type: 'bridge.connected',
      connId,
      previewToken,
      origin,
      userAgent,
      connectedAt,
    });
    return websocketResponse(client);
  }

  private ensureWebSocketAutoResponse(): void {
    if (this.autoResponseSet) return;
    if (typeof WebSocketRequestResponsePair !== 'undefined') {
      this.state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('ping', 'pong'));
    }
    this.autoResponseSet = true;
  }

  private async handleWebhook(
    token: string,
    request: Request,
    webhookId?: string
  ): Promise<Response> {
    if (!this.matchesToken(token, this.requireTray().webhookToken)) {
      return jsonResponse(
        { error: 'Invalid webhook capability', code: 'INVALID_WEBHOOK_CAPABILITY' },
        403,
        {
          'access-control-allow-origin': '*',
        }
      );
    }

    if (!webhookId) {
      return jsonResponse(
        {
          error: 'Webhook ID is required. Use POST /webhook/{token}/{webhookId}',
          code: 'WEBHOOK_ID_REQUIRED',
        },
        400,
        { 'access-control-allow-origin': '*' }
      );
    }

    if (!this.hasLiveLeader()) {
      return jsonResponse(
        {
          error: 'No live leader is connected for this tray',
          code: 'NO_LIVE_LEADER',
        },
        410,
        { 'access-control-allow-origin': '*' }
      );
    }

    // Read the request body
    let body: unknown;
    try {
      const contentType = request.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        body = await request.json();
      } else {
        const text = await request.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
      }
    } catch {
      body = {};
    }

    // Collect relevant headers (skip Cloudflare-internal headers and host).
    // Strip reserved `x-slicc-preview-*` headers: those are how the DO attributes
    // a bridge-WS emit to a specific preview tab (rendered as a trusted "Preview
    // Event"). Only the DO's own emit path may set them — a public webhook POST
    // carrying them would otherwise forge tab attribution into the cone.
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      if (key.startsWith('cf-') || key === 'host' || key.startsWith('x-slicc-preview-')) {
        continue;
      }
      headers[key] = value;
    }

    // Forward to leader via the control WebSocket, asking for the disposition
    // so a dropped delivery does not get a success receipt (issue #2524).
    const deliveryId = `wd-${++this.webhookDeliveryCounter}-${this.now()}`;
    const settled = new Promise<WebhookDeliveryDisposition | null>((resolve) => {
      this.pendingWebhookDeliveries.set(deliveryId, resolve);
    });
    const sent = this.sendToLeader({
      type: 'webhook.event',
      webhookId,
      headers,
      body,
      timestamp: this.isoNow(),
      deliveryId,
    });

    if (!sent) {
      this.pendingWebhookDeliveries.delete(deliveryId);
      return jsonResponse(
        {
          error: 'Failed to forward webhook to leader',
          code: 'LEADER_SEND_FAILED',
        },
        502,
        { 'access-control-allow-origin': '*' }
      );
    }

    const disposition = await this.awaitWebhookDelivery(deliveryId, settled);
    return webhookDeliveryResponse(webhookId, disposition);
  }

  /**
   * Wait out the leader's `webhook.delivery` for `deliveryId`, resolving `null`
   * once {@link WEBHOOK_DELIVERY_WAIT_MS} passes. A leader that predates #2524
   * never answers, so `null` must keep the pre-#2524 receipt: we know the event
   * was forwarded, and nothing more.
   */
  private awaitWebhookDelivery(
    deliveryId: string,
    settled: Promise<WebhookDeliveryDisposition | null>
  ): Promise<WebhookDeliveryDisposition | null> {
    return Promise.race([
      settled,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), this.webhookDeliveryWaitMs)),
    ]).finally(() => this.pendingWebhookDeliveries.delete(deliveryId));
  }

  /**
   * Leader→bridge: route a CDP request to the matching bridge socket by its
   * `conn:<connId>` tag (indexed lookup, not an O(n) scan). When the visitor tab
   * is gone (closed / revoked), fail the leader's pending call fast instead of
   * letting it burn the full CDP timeout, so it can drop the phantom transport.
   */
  private relayCdpRequestToBridge(message: LeaderBridgeCdpRequest): void {
    const target = (this.state.getWebSockets?.(`conn:${message.connId}`) ?? [])[0] as
      | TrayWebSocketLike
      | undefined;
    if (!target) {
      this.sendToLeader({
        type: 'bridge.cdp.response',
        connId: message.connId,
        id: message.id,
        error: { code: -32000, message: 'Preview bridge connection is gone' },
      });
      return;
    }
    target.send(
      JSON.stringify({
        t: 'cdp.req',
        id: message.id,
        method: message.method,
        params: message.params,
        sessionId: message.sessionId,
      })
    );
  }

  /** Hand a leader-reported disposition to the waiting webhook POST, if any. */
  private settleWebhookDelivery(message: LeaderWebhookDelivery): void {
    const resolve = this.pendingWebhookDeliveries.get(message.deliveryId);
    if (!resolve) return;
    this.pendingWebhookDeliveries.delete(message.deliveryId);
    resolve(message.disposition);
  }

  private handleLeaderBootstrapOffer(
    socket: TrayWebSocketLike,
    message: LeaderToWorkerControlMessage & { type: 'bootstrap.offer' }
  ): void {
    const bootstrap = this.findBootstrap(message.controllerId, message.bootstrapId);
    if (!bootstrap) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'BOOTSTRAP_NOT_FOUND',
          bootstrapId: message.bootstrapId,
        })
      );
      return;
    }
    this.refreshBootstrapState(bootstrap);
    if (bootstrap.state !== 'failed') {
      this.appendBootstrapEvent(bootstrap, {
        type: 'bootstrap.offer',
        offer: message.offer,
      });
      bootstrap.state = 'offered';
      bootstrap.failure = null;
    }
  }

  private handleLeaderBootstrapIceCandidate(
    socket: TrayWebSocketLike,
    message: LeaderToWorkerControlMessage & { type: 'bootstrap.ice_candidate' }
  ): void {
    const bootstrap = this.findBootstrap(message.controllerId, message.bootstrapId);
    if (!bootstrap) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'BOOTSTRAP_NOT_FOUND',
          bootstrapId: message.bootstrapId,
        })
      );
      return;
    }
    this.refreshBootstrapState(bootstrap);
    if (bootstrap.state !== 'failed') {
      this.appendBootstrapEvent(bootstrap, {
        type: 'bootstrap.ice_candidate',
        candidate: message.candidate,
      });
    }
  }

  private handleLeaderBootstrapFailed(
    socket: TrayWebSocketLike,
    message: LeaderToWorkerControlMessage & { type: 'bootstrap.failed' }
  ): void {
    const bootstrap = this.findBootstrap(message.controllerId, message.bootstrapId);
    if (!bootstrap) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'BOOTSTRAP_NOT_FOUND',
          bootstrapId: message.bootstrapId,
        })
      );
      return;
    }
    this.failBootstrap(bootstrap, {
      code: message.code,
      message: message.message,
      retryable: message.retryable ?? this.canRetryBootstrap(bootstrap),
      retryAfterMs:
        message.retryable === false
          ? null
          : (message.retryAfterMs ?? TRAY_BOOTSTRAP_RETRY_AFTER_MS),
    });
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
      let persistentMutation = true;

      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', trayId: this.tray.trayId }));
        persistentMutation = false;
      } else if (message.type === 'bootstrap.offer') {
        this.handleLeaderBootstrapOffer(socket, message);
      } else if (message.type === 'bootstrap.ice_candidate') {
        this.handleLeaderBootstrapIceCandidate(socket, message);
      } else if (message.type === 'bootstrap.failed') {
        this.handleLeaderBootstrapFailed(socket, message);
      } else if (message.type === 'preview.response') {
        pushPreviewResponseChunk(this.pendingPreviews, message as unknown as PreviewResponseChunk);
        persistentMutation = false;
      } else if (message.type === 'preview.state.update') {
        const record = this.tray.previews?.[message.previewToken];
        if (record) record.announced = message.announced;
      } else if (message.type === 'preview.purge') {
        await handlePreviewPurge(message.previewToken, this.previewDeps());
      } else if (message.type === 'bridge.cdp.request') {
        this.relayCdpRequestToBridge(message);
        persistentMutation = false;
      } else if (message.type === 'webhook.delivery') {
        this.settleWebhookDelivery(message);
        persistentMutation = false;
      } else if (message.type === 'push.register') {
        this.handlePushRegister(message);
      } else if (message.type === 'push.send') {
        await this.handlePushSend(message);
        persistentMutation = false;
      } else if (message.type === 'bridge.close') {
        // Leader closed a preview target: close that visitor's bridge socket and
        // tell the leader it's gone (a server-initiated close won't re-fire
        // webSocketClose in workerd, so we can't rely on the close handler).
        const target = (this.state.getWebSockets?.(`conn:${message.connId}`) ?? [])[0] as
          | TrayWebSocketLike
          | undefined;
        this.bridgeEmitWindows.delete(message.connId);
        this.sendToLeader({ type: 'bridge.disconnected', connId: message.connId });
        target?.close(1000, 'closed by leader');
        persistentMutation = false;
      }

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

  private async handleBootstrapPoll(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    cursor: number
  ): Promise<Response> {
    const bootstrap = this.findBootstrap(controllerId, bootstrapId);
    if (!bootstrap) {
      return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
    }

    this.refreshBootstrapState(bootstrap);
    await this.persistTray();
    return await this.buildFollowerBootstrapResponse(
      bootstrap,
      this.getBootstrapEventsAfter(bootstrap, cursor)
    );
  }

  private async handleBootstrapAnswer(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    answer: TraySessionDescription | undefined
  ): Promise<Response> {
    if (!this.isSessionDescription(answer, 'answer')) {
      return jsonResponse(
        { error: 'A valid bootstrap answer is required', code: 'INVALID_BOOTSTRAP_REQUEST' },
        400
      );
    }

    const bootstrap = this.findBootstrap(controllerId, bootstrapId);
    if (!bootstrap) {
      return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
    }

    this.refreshBootstrapState(bootstrap);
    if (bootstrap.state === 'failed') {
      await this.persistTray();
      return await this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    if (
      !this.sendToLeader({
        type: 'bootstrap.answer',
        trayId: this.requireTray().trayId,
        controllerId: bootstrap.controllerId,
        bootstrapId: bootstrap.bootstrapId,
        answer,
      })
    ) {
      this.failBootstrap(bootstrap, {
        code: 'LEADER_NOT_CONNECTED',
        message: 'Leader control channel is not connected',
        retryable: this.canRetryBootstrap(bootstrap),
        retryAfterMs: this.canRetryBootstrap(bootstrap) ? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null,
      });
      await this.persistTray();
      return await this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    bootstrap.state = 'connected';
    bootstrap.failure = null;
    bootstrap.updatedAt = this.isoNow();
    await this.persistTray();
    return await this.buildFollowerBootstrapResponse(bootstrap, []);
  }

  private async handleBootstrapIceCandidate(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    candidate: TrayIceCandidate | undefined
  ): Promise<Response> {
    if (!this.isIceCandidate(candidate)) {
      return jsonResponse(
        { error: 'A valid ICE candidate is required', code: 'INVALID_BOOTSTRAP_REQUEST' },
        400
      );
    }

    const bootstrap = this.findBootstrap(controllerId, bootstrapId);
    if (!bootstrap) {
      return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
    }

    this.refreshBootstrapState(bootstrap);
    if (bootstrap.state === 'failed') {
      await this.persistTray();
      return await this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    if (
      !this.sendToLeader({
        type: 'bootstrap.ice_candidate',
        trayId: this.requireTray().trayId,
        controllerId: bootstrap.controllerId,
        bootstrapId: bootstrap.bootstrapId,
        candidate,
      })
    ) {
      this.failBootstrap(bootstrap, {
        code: 'LEADER_NOT_CONNECTED',
        message: 'Leader control channel is not connected',
        retryable: this.canRetryBootstrap(bootstrap),
        retryAfterMs: this.canRetryBootstrap(bootstrap) ? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null,
      });
      await this.persistTray();
      return await this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    bootstrap.updatedAt = this.isoNow();
    await this.persistTray();
    return await this.buildFollowerBootstrapResponse(bootstrap, []);
  }

  private async handleBootstrapRetry(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    runtime: string | undefined
  ): Promise<Response> {
    const bootstrap = this.findBootstrap(controllerId, bootstrapId);
    if (!bootstrap) {
      return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
    }

    this.refreshBootstrapState(bootstrap);
    if (
      bootstrap.state !== 'failed' ||
      !bootstrap.failure?.retryable ||
      !this.canRetryBootstrap(bootstrap) ||
      !this.hasLiveLeader()
    ) {
      await this.persistTray();
      return await this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    this.pruneTerminalBootstraps();
    const retried = this.createBootstrap(
      bootstrap.controllerId,
      runtime ?? bootstrap.runtime,
      bootstrap.retryCount + 1,
      bootstrap.maxRetries,
      // Carry the seat forward: a retried bootstrap that dropped `biscottoId`
      // would be announced to the leader as a full-trust follower.
      bootstrap.biscottoId
    );
    this.requireTray().bootstraps[retried.bootstrapId] = retried;
    const iceServers = await this.getIceServers();
    this.notifyLeaderJoinRequested(retried, iceServers);
    await this.persistTray();
    return await this.buildFollowerBootstrapResponse(retried, []);
  }

  private async ensureBootstrap(
    controllerId: string,
    runtime: string | undefined,
    biscottoId?: string
  ): Promise<TrayBootstrapRecord> {
    this.pruneTerminalBootstraps();
    const existing = this.findBootstrap(controllerId);
    // Reuse ONLY within the same capability. `controllerId` is client-supplied
    // and a non-terminal bootstrap outlives its controller record
    // (`pruneStaleControllers` prunes controllers, `pruneTerminalBootstraps`
    // only reaps terminal bootstraps), so a guest presenting a pruned full
    // follower's controllerId would otherwise adopt that follower's
    // `biscottoId: undefined` bootstrap and be announced as `trust: 'full'` —
    // straight past the allowlist. Mismatched capability ⇒ mint a fresh one.
    if (existing && existing.biscottoId === biscottoId) {
      this.refreshBootstrapState(existing);
      return existing;
    }

    const bootstrap = this.createBootstrap(
      controllerId,
      runtime,
      0,
      TRAY_BOOTSTRAP_MAX_RETRIES,
      biscottoId
    );
    this.requireTray().bootstraps[bootstrap.bootstrapId] = bootstrap;
    const iceServers = await this.getIceServers();
    this.notifyLeaderJoinRequested(bootstrap, iceServers);
    return bootstrap;
  }

  private createBootstrap(
    controllerId: string,
    runtime: string | undefined,
    retryCount = 0,
    maxRetries = TRAY_BOOTSTRAP_MAX_RETRIES,
    biscottoId?: string
  ): TrayBootstrapRecord {
    const createdAt = this.isoNow();
    return {
      controllerId,
      bootstrapId: crypto.randomUUID(),
      runtime,
      attempt: retryCount + 1,
      retryCount,
      maxRetries,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(this.now() + TRAY_BOOTSTRAP_TIMEOUT_MS).toISOString(),
      state: 'pending',
      failure: null,
      events: [],
      nextSequence: 1,
      biscottoId,
    };
  }

  private notifyLeaderJoinRequested(
    bootstrap: TrayBootstrapRecord,
    iceServers?: TurnIceServer[]
  ): void {
    const message: WorkerToLeaderControlMessage = {
      type: 'follower.join_requested',
      trayId: this.requireTray().trayId,
      controllerId: bootstrap.controllerId,
      runtime: bootstrap.runtime,
      bootstrapId: bootstrap.bootstrapId,
      attempt: bootstrap.attempt,
      expiresAt: bootstrap.expiresAt,
      // The leader's controller socket is the ONLY authenticated channel that
      // can tell it what a peer is; the peer's own `hello` cannot be believed.
      ...this.biscottoAnnouncement(bootstrap),
    };
    if (iceServers) {
      (message as { iceServers?: TurnIceServer[] }).iceServers = iceServers;
    }
    this.sendToLeader(message);
  }

  /**
   * Trust fields for a `follower.join_requested`. A bootstrap with no
   * `biscottoId` is a full follower and gets `trust: 'full'` stated
   * explicitly — silence would be ambiguous with an older hub.
   *
   * A seat that was revoked between attach and announcement resolves to no
   * record; that announces as a biscotto with its stored id and empty label
   * rather than falling back to `full`, because failing toward MORE trust here
   * would turn a revocation race into a privilege escalation.
   */
  private biscottoAnnouncement(bootstrap: TrayBootstrapRecord): {
    trust: FollowerTrust;
    biscotto?: FollowerBiscottoIdentity;
  } {
    if (!bootstrap.biscottoId) return { trust: 'full' };
    const record = (this.requireTray().biscotti ?? []).find(
      (entry) => entry.id === bootstrap.biscottoId
    );
    return {
      trust: 'biscotto',
      biscotto: {
        id: bootstrap.biscottoId,
        label: record?.label ?? '',
        expiresAt: record?.expiresAt,
        gates: {
          message: normalizeBiscottoGate(record?.gates.message),
          tool: normalizeBiscottoGate(record?.gates.tool),
        },
      },
    };
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

  private findBootstrap(controllerId?: string, bootstrapId?: string): TrayBootstrapRecord | null {
    const tray = this.requireTray();
    const values = Object.values(tray.bootstraps);

    if (bootstrapId) {
      const bootstrap = tray.bootstraps[bootstrapId] ?? null;
      if (!bootstrap) {
        return null;
      }
      return controllerId && bootstrap.controllerId !== controllerId ? null : bootstrap;
    }

    if (!controllerId) {
      return null;
    }

    return (
      values
        .filter((bootstrap) => bootstrap.controllerId === controllerId)
        .sort(
          (left, right) =>
            right.attempt - left.attempt || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        )[0] ?? null
    );
  }

  private refreshBootstrapState(bootstrap: TrayBootstrapRecord): void {
    if (bootstrap.state === 'failed' || bootstrap.state === 'connected') {
      return;
    }

    if (!this.hasLiveLeader()) {
      this.failBootstrap(bootstrap, {
        code: 'LEADER_NOT_CONNECTED',
        message: 'Leader control channel disconnected before bootstrap completed',
        retryable: this.canRetryBootstrap(bootstrap),
        retryAfterMs: this.canRetryBootstrap(bootstrap) ? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null,
      });
      return;
    }

    if (this.now() > Date.parse(bootstrap.expiresAt)) {
      this.failBootstrap(bootstrap, {
        code: 'BOOTSTRAP_TIMEOUT',
        message: `Bootstrap attempt timed out after ${TRAY_BOOTSTRAP_TIMEOUT_MS}ms`,
        retryable: this.canRetryBootstrap(bootstrap),
        retryAfterMs: this.canRetryBootstrap(bootstrap) ? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null,
      });
    }
  }

  private failBootstrap(
    bootstrap: TrayBootstrapRecord,
    failure: Omit<TrayBootstrapFailure, 'failedAt'> & { failedAt?: string }
  ): void {
    if (bootstrap.state === 'failed') {
      return;
    }

    const failedAt = failure.failedAt ?? this.isoNow();
    const normalizedFailure: TrayBootstrapFailure = {
      ...failure,
      failedAt,
    };
    bootstrap.state = 'failed';
    bootstrap.failure = normalizedFailure;
    bootstrap.expiresAt = failedAt;
    this.appendBootstrapEvent(
      bootstrap,
      {
        type: 'bootstrap.failed',
        failure: normalizedFailure,
      },
      failedAt
    );
  }

  private appendBootstrapEvent(
    bootstrap: TrayBootstrapRecord,
    event: TrayBootstrapEventInput,
    sentAt = this.isoNow()
  ): TrayBootstrapEvent {
    const nextEvent = {
      ...event,
      sequence: bootstrap.nextSequence,
      sentAt,
    } as TrayBootstrapEvent;
    bootstrap.nextSequence += 1;
    bootstrap.updatedAt = sentAt;
    bootstrap.events.push(nextEvent);
    // Cap events to avoid unbounded growth from SDP payloads (KB each).
    // The follower polls via cursor so only the tail matters, but the offer
    // is only carried in the events stream — preserve it at the head so a
    // burst of ICE candidates can't drop it and force a timeout+retry.
    if (bootstrap.events.length > MAX_BOOTSTRAP_EVENTS) {
      const offer = bootstrap.events.find((e) => e.type === 'bootstrap.offer');
      const tailSize = offer ? MAX_BOOTSTRAP_EVENTS - 1 : MAX_BOOTSTRAP_EVENTS;
      const tail = bootstrap.events.slice(-tailSize);
      bootstrap.events = offer && !tail.includes(offer) ? [offer, ...tail] : tail;
    }
    return nextEvent;
  }

  private getBootstrapEventsAfter(
    bootstrap: TrayBootstrapRecord,
    cursor: number
  ): TrayBootstrapEvent[] {
    const normalizedCursor = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
    return bootstrap.events.filter((event) => event.sequence > normalizedCursor);
  }

  private buildBootstrapStatus(bootstrap: TrayBootstrapRecord): TrayBootstrapStatus {
    return {
      controllerId: bootstrap.controllerId,
      bootstrapId: bootstrap.bootstrapId,
      attempt: bootstrap.attempt,
      state: bootstrap.state,
      expiresAt: bootstrap.expiresAt,
      cursor: Math.max(0, bootstrap.nextSequence - 1),
      maxRetries: bootstrap.maxRetries,
      retriesRemaining: Math.max(0, bootstrap.maxRetries - bootstrap.retryCount),
      retryAfterMs: bootstrap.failure?.retryable
        ? (bootstrap.failure.retryAfterMs ?? TRAY_BOOTSTRAP_RETRY_AFTER_MS)
        : null,
      failure: bootstrap.failure,
    };
  }

  private async buildFollowerBootstrapResponse(
    bootstrap: TrayBootstrapRecord,
    events: TrayBootstrapEvent[],
    status = 200
  ): Promise<Response> {
    const tray = this.requireTray();
    const iceServers = await this.getIceServers();
    const payload: FollowerBootstrapResponse = {
      trayId: tray.trayId,
      controllerId: bootstrap.controllerId,
      role: 'follower',
      leader: await this.leaderSummary(),
      participantCount: Object.keys(tray.controllers).length,
      bootstrap: this.buildBootstrapStatus(bootstrap),
      events,
    };
    if (iceServers) {
      payload.iceServers = iceServers;
    }
    return jsonResponse(payload, status);
  }

  private canRetryBootstrap(bootstrap: TrayBootstrapRecord): boolean {
    return bootstrap.retryCount < bootstrap.maxRetries;
  }

  /**
   * Remove bootstrap records in a terminal state whose grace window has
   * elapsed. Called opportunistically when bootstraps are mutated.
   */
  private pruneTerminalBootstraps(): void {
    const tray = this.requireTray();
    const nowMs = this.now();
    for (const [id, bootstrap] of Object.entries(tray.bootstraps)) {
      const isTerminal =
        bootstrap.state === 'connected' ||
        (bootstrap.state === 'failed' && !this.canRetryBootstrap(bootstrap));
      if (!isTerminal) continue;
      const deadlineMs = Date.parse(bootstrap.expiresAt) + BOOTSTRAP_TERMINAL_GRACE_MS;
      if (nowMs > deadlineMs) {
        delete tray.bootstraps[id];
      }
    }
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

  private async readJoinRequest(request: Request, url: URL): Promise<JoinRequest> {
    const queryAttach: ControllerAttachRequest = {
      controllerId: url.searchParams.get('controllerId') ?? undefined,
      runtime: url.searchParams.get('runtime') ?? undefined,
    };

    if (request.method !== 'POST') {
      return queryAttach;
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return queryAttach;
    }

    try {
      const body = (await request.json()) as FollowerBootstrapBody;
      const controllerId =
        typeof body['controllerId'] === 'string' ? body['controllerId'] : queryAttach.controllerId;
      const bootstrapId = typeof body['bootstrapId'] === 'string' ? body['bootstrapId'] : undefined;
      const runtime = typeof body['runtime'] === 'string' ? body['runtime'] : queryAttach.runtime;

      switch (body['action']) {
        case 'poll':
          return {
            action: 'poll',
            controllerId,
            bootstrapId,
            cursor: typeof body['cursor'] === 'number' ? body['cursor'] : undefined,
          };
        case 'answer':
          return {
            action: 'answer',
            controllerId,
            bootstrapId,
            answer: body['answer'] as TraySessionDescription | undefined,
          };
        case 'ice-candidate':
          return {
            action: 'ice-candidate',
            controllerId,
            bootstrapId,
            candidate: body['candidate'] as TrayIceCandidate | undefined,
          };
        case 'retry':
          return {
            action: 'retry',
            controllerId,
            bootstrapId,
            runtime,
          };
      }

      return {
        controllerId:
          typeof body?.['controllerId'] === 'string'
            ? body['controllerId']
            : queryAttach.controllerId,
        runtime: typeof body?.['runtime'] === 'string' ? body['runtime'] : queryAttach.runtime,
      };
    } catch {
      return queryAttach;
    }
  }

  private async readAttachRequest(request: Request, url: URL): Promise<ControllerAttachRequest> {
    const queryAttach: ControllerAttachRequest = {
      controllerId: url.searchParams.get('controllerId') ?? undefined,
      leaderKey: url.searchParams.get('leaderKey') ?? undefined,
      runtime: url.searchParams.get('runtime') ?? undefined,
    };

    if (request.method !== 'POST') {
      return queryAttach;
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return queryAttach;
    }

    try {
      const body = (await request.json()) as ControllerAttachRequest;
      return {
        controllerId: body.controllerId ?? queryAttach.controllerId,
        leaderKey: body.leaderKey ?? queryAttach.leaderKey,
        runtime: body.runtime ?? queryAttach.runtime,
      };
    } catch {
      return queryAttach;
    }
  }

  private isBootstrapRequest(request: JoinRequest): request is FollowerBootstrapRequest {
    return 'action' in request;
  }

  private getJoinRequestControllerId(request: JoinRequest): string {
    return request.controllerId ?? crypto.randomUUID();
  }

  private isSessionDescription(
    value: TraySessionDescription | undefined,
    expectedType: TraySessionDescription['type']
  ): value is TraySessionDescription {
    return Boolean(value && value.type === expectedType && typeof value.sdp === 'string');
  }

  private isIceCandidate(value: TrayIceCandidate | undefined): value is TrayIceCandidate {
    return Boolean(value && typeof value.candidate === 'string');
  }

  private buildLeaderWebSocketUrl(url: URL, controllerId: string, leaderKey: string): string {
    const webSocketUrl = new URL(
      url.pathname,
      `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
    );
    webSocketUrl.searchParams.set('controllerId', controllerId);
    webSocketUrl.searchParams.set('leaderKey', leaderKey);
    return webSocketUrl.toString();
  }

  /**
   * Advisory trust for a follower-facing response body, read back off the
   * controller record stamped at attach time. Purely so a guest page can
   * render itself honestly; the leader never reads this back.
   */
  private trustForController(controllerId: string): FollowerTrust {
    return this.requireTray().controllers[controllerId]?.biscottoId ? 'biscotto' : 'full';
  }

  private matchesToken(received: string, expected: string): boolean {
    return timingSafeEqual(received, expected);
  }

  private createLeaderKey(): string {
    return crypto.randomUUID();
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

  /**
   * A follower registered a push token via the leader (issue #2062). The
   * leader already validated the shape; re-check here because the DO is the
   * trust boundary for what it stores. Bounded per tray; re-registering the
   * same token just refreshes it.
   */
  private handlePushRegister(message: {
    bootstrapId?: unknown;
    platform?: unknown;
    token?: unknown;
    environment?: unknown;
  }): void {
    const tray = this.requireTray();
    const token = typeof message.token === 'string' ? message.token.trim() : '';
    if (message.platform !== 'ios' || !/^[0-9a-fA-F]{32,400}$/.test(token)) return;
    const environment = message.environment === 'production' ? 'production' : 'sandbox';
    const bootstrapId = typeof message.bootstrapId === 'string' ? message.bootstrapId : '';
    tray.pushTokens ??= {};
    tray.pushTokens[token] = {
      platform: 'ios',
      environment,
      bootstrapId,
      registeredAt: this.isoNow(),
    };
    const entries = Object.entries(tray.pushTokens);
    if (entries.length > MAX_PUSH_TOKENS_PER_TRAY) {
      const evict = entries
        .sort((a, b) => a[1].registeredAt.localeCompare(b[1].registeredAt))
        .slice(0, entries.length - MAX_PUSH_TOKENS_PER_TRAY);
      for (const [dead] of evict) delete tray.pushTokens[dead];
    }
  }

  /**
   * Fan a leader push out to every registered device. Dead tokens (410 /
   * BadDeviceToken) are forgotten and the record persisted; transport errors
   * are logged and the token kept. Never throws into the leader socket loop.
   */
  private async handlePushSend(message: {
    category?: unknown;
    label?: unknown;
    requestId?: unknown;
  }): Promise<void> {
    const tray = this.requireTray();
    const tokens = Object.entries(tray.pushTokens ?? {});
    if (tokens.length === 0) return;
    if (!this.apns) {
      if (!this.apnsDisabledLogged) {
        this.apnsDisabledLogged = true;
        console.warn('[push] APNs secrets not configured — push.send ignored', {
          trayId: tray.trayId,
        });
      }
      return;
    }
    const category = message.category === 'sudo_request' ? 'sudo_request' : 'turn_end';
    if (message.category !== 'sudo_request' && message.category !== 'turn_end') return;
    const label =
      typeof message.label === 'string' && message.label.trim()
        ? message.label.trim().slice(0, 80)
        : 'SLICC';
    const requestId =
      typeof message.requestId === 'string' && message.requestId ? message.requestId : undefined;

    const results = await Promise.all(
      tokens.map(([token, record]) =>
        this.apns!.send({
          token,
          environment: record.environment,
          category,
          label,
          trayId: tray.trayId,
          ...(requestId ? { requestId } : {}),
        }).catch(
          (err): ApnsPushResult => ({
            token,
            status: 0,
            reason: err instanceof Error ? err.message : String(err),
            dropToken: false,
          })
        )
      )
    );
    let mutated = false;
    for (const result of results) {
      if (result.dropToken && this.forgetsPushToken(tray, result)) {
        delete tray.pushTokens?.[result.token];
        mutated = true;
        continue;
      }
      if (result.status !== 200) {
        console.warn('[push] APNs delivery failed', {
          trayId: tray.trayId,
          status: result.status,
          reason: result.reason,
          // Apple asks for this id when investigating a push that never landed.
          ...(result.uniqueId ? { uniqueId: result.uniqueId } : {}),
        });
      }
    }
    if (mutated) await this.persistTray();
  }

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

  /**
   * Should a dead-token verdict actually evict the registration? Apple's 410
   * body carries the instant the token stopped being valid; a device that
   * re-registered after that instant has a live token again and must be kept,
   * or a reconnect race silently unsubscribes a phone that is right there.
   * A 400 `BadDeviceToken` carries no timestamp and is unconditionally final.
   */
  private forgetsPushToken(tray: TrayRecord, result: ApnsPushResult): boolean {
    if (result.invalidatedAtMs === undefined) return true;
    const record = tray.pushTokens?.[result.token];
    if (!record) return true;
    const registeredAtMs = Date.parse(record.registeredAt);
    if (!Number.isFinite(registeredAtMs)) return true;
    return registeredAtMs < result.invalidatedAtMs;
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

  private isoNow(): string {
    return new Date(this.now()).toISOString();
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
        this.closeBridgeSocketsForPreview(previewToken);
      }
      return response;
    }
    return dispatchPreviewRoute(url, request, this.previewDeps());
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
      return this.handleInternalBiscottoRoute(url, request);
    }
    return null;
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

  /**
   * `/internal/biscotto/{mint,stop,list}` — the DO half of `biscotto-routes.ts`.
   *
   * Every branch reads the controller token out of the body and hands it to the
   * lifecycle helper, which is what actually authenticates it. A thrown
   * {@link BiscottoRouteError} carries the status; anything else is a 500 with
   * no detail, so an internal failure never describes the tray to a caller that
   * did not authenticate.
   */
  private async handleInternalBiscottoRoute(url: URL, request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }
    let body: {
      controllerToken?: string;
      label?: string;
      id?: string;
      ttlMs?: number;
      gates?: Partial<BiscottoGates>;
      workerBaseUrl?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'invalid body' }, 400);
    }
    const controllerToken = typeof body.controllerToken === 'string' ? body.controllerToken : '';
    try {
      switch (url.pathname) {
        case '/internal/biscotto/mint':
          return jsonResponse(
            await mintBiscottoImpl(
              {
                controllerToken,
                label: body.label ?? '',
                ttlMs: body.ttlMs,
                gates: body.gates,
                workerBaseUrl: body.workerBaseUrl ?? '',
              },
              this.biscottoDeps()
            )
          );
        case '/internal/biscotto/stop': {
          const revoked = await revokeBiscottoImpl(
            { controllerToken, id: body.id ?? '' },
            this.biscottoDeps()
          );
          // Tombstoning the token only stops future joins. A live guest holds a
          // direct data channel to the leader that this DO cannot reach, so the
          // eviction has to be delegated to the one process that can — and if
          // that message did not land, the seat is revoked for FUTURE joins
          // while whoever is already connected keeps their channel. Reporting
          // plain success there would tell an owner the guest is out when they
          // are not, so the outcome says which happened.
          const evicted = this.sendToLeader({
            type: 'biscotto.revoked',
            trayId: this.requireTray().trayId,
            biscottoId: revoked.id,
          });
          if (!evicted) {
            console.warn('[tray] biscotto revoked but the leader could not be told', {
              biscottoId: revoked.id,
            });
          }
          return jsonResponse({ ...revoked, evicted });
        }
        case '/internal/biscotto/list':
          return jsonResponse({
            biscotti: await listBiscottiImpl({ controllerToken }, this.biscottoDeps()),
          });
        default:
          return jsonResponse({ error: 'not found' }, 404);
      }
    } catch (error) {
      if (error instanceof BiscottoRouteError) {
        return jsonResponse({ error: error.message }, error.status);
      }
      return jsonResponse({ error: 'biscotto request failed' }, 500);
    }
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

  private closeBridgeSocketsForPreview(previewToken: string): void {
    for (const ws of (this.state.getWebSockets?.(BRIDGE_WS_TAG) ?? []) as TrayWebSocketLike[]) {
      if (!this.state.getTags?.(ws)?.includes(`tok:${previewToken}`)) continue;
      // A server-initiated `ws.close()` does NOT re-invoke webSocketClose in
      // workerd, so notify the leader and evict per-conn state HERE. Otherwise the
      // leader keeps a phantom `preview:` target that hangs every CDP call for the
      // 30s timeout. (A duplicate bridge.disconnected, should webSocketClose also
      // fire, is a harmless no-op on the leader's `if (!entry) return` path.)
      const { connId } = (ws.deserializeAttachment?.() ?? {}) as { connId?: string };
      if (connId) {
        this.bridgeEmitWindows.delete(connId);
        this.sendToLeader({ type: 'bridge.disconnected', connId });
      }
      ws.close(1000, 'preview revoked');
    }
  }
}
