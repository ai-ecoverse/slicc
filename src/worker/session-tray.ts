import {
  FOLLOWER_ATTACH_RETRY_AFTER_MS,
  type FollowerBootstrapResponse,
  jsonResponse,
  TRAY_RECLAIM_TTL_MS,
  websocketResponse,
  type CreateTrayRequest,
  type DurableObjectStateLike,
  type FollowerAttachResponse,
  type FollowerAttachResult,
  type TrayRecord,
  type TrayLeaderSummary,
} from './shared.js';
import {
  TRAY_BOOTSTRAP_MAX_RETRIES,
  TRAY_BOOTSTRAP_RETRY_AFTER_MS,
  TRAY_BOOTSTRAP_TIMEOUT_MS,
  type FollowerBootstrapRequest,
  type LeaderToWorkerControlMessage,
  type TrayBootstrapEvent,
  type TrayBootstrapFailure,
  type TrayBootstrapRecord,
  type TrayBootstrapStatus,
  type TrayIceCandidate,
  type TraySessionDescription,
  type WorkerToLeaderControlMessage,
} from './tray-signaling.js';

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

interface TrayWebSocketLike {
  accept?: () => void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: string }) => void,
  ): void;
}

interface SessionTrayOptions {
  now?: () => number;
  webSocketPairFactory?: () => { client: unknown; server: TrayWebSocketLike };
}

const TRAY_STORAGE_KEY = 'tray';

export class SessionTrayDurableObject {
  private readonly now: () => number;
  private readonly webSocketPairFactory: () => { client: unknown; server: TrayWebSocketLike };
  private tray: TrayRecord | null = null;
  private leaderSocket: TrayWebSocketLike | null = null;

  constructor(
    private readonly state: DurableObjectStateLike,
    _env: unknown,
    options: SessionTrayOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.webSocketPairFactory = options.webSocketPairFactory ?? (() => {
      const PairCtor = (globalThis as { WebSocketPair?: new () => { 0: unknown; 1: unknown } }).WebSocketPair;
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

    await this.loadTray();
    if (!this.tray) {
      return jsonResponse({ error: 'Tray not initialized', code: 'TRAY_NOT_INITIALIZED' }, 500);
    }

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
      controllers: {},
      bootstraps: {},
      leader: null,
    };
    await this.persistTray();
    return jsonResponse(this.tray, 201);
  }

  private async handleJoin(request: Request, token: string, url: URL): Promise<Response> {
    const tray = this.requireTray();
    const joinRequest = request.method === 'POST' ? await this.readJoinRequest(request, url) : null;
    if (!this.matchesToken(token, tray.joinToken)) {
      if (joinRequest) {
        return this.buildFollowerAttachResponse(this.getJoinRequestControllerId(joinRequest), {
          action: 'fail',
          code: 'INVALID_JOIN_CAPABILITY',
          error: 'Invalid join capability',
        }, 403);
      }
      return jsonResponse({ error: 'Invalid join capability', code: 'INVALID_JOIN_CAPABILITY' }, 403);
    }

    const expiration = await this.ensureTrayIsActive();
    if (expiration) {
      if (joinRequest) {
        return this.buildFollowerAttachResponse(this.getJoinRequestControllerId(joinRequest), {
          action: 'fail',
          code: 'TRAY_EXPIRED',
          error: 'Tray expired because the leader did not reclaim it within one hour',
        }, 410);
      }
      return expiration;
    }

    if (joinRequest) {
      if (this.isBootstrapRequest(joinRequest)) {
        return this.handleBootstrapRequest(joinRequest);
      }
      return this.handleFollowerAttach(joinRequest);
    }

    const payload = {
      trayId: tray.trayId,
      capability: 'join',
      leader: this.leaderSummary(),
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
        409,
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

  private async handleFollowerAttach(attach: ControllerAttachRequest): Promise<Response> {
    const tray = this.requireTray();
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

    const result: FollowerAttachResult = this.hasLiveLeader()
      ? {
          action: 'signal',
          code: 'LEADER_CONNECTED',
          bootstrap: this.buildBootstrapStatus(this.ensureBootstrap(controllerId, attach.runtime)),
        }
      : {
          action: 'wait',
          code: tray.leader ? 'LEADER_NOT_CONNECTED' : 'LEADER_NOT_ELECTED',
          retryAfterMs: FOLLOWER_ATTACH_RETRY_AFTER_MS,
        };

    await this.persistTray();

    return this.buildFollowerAttachResponse(controllerId, result);
  }

  private async handleBootstrapRequest(request: FollowerBootstrapRequest): Promise<Response> {
    switch (request.action) {
      case 'poll':
        return this.handleBootstrapPoll(request.controllerId, request.bootstrapId, request.cursor ?? 0);
      case 'answer':
        return this.handleBootstrapAnswer(request.controllerId, request.bootstrapId, request.answer);
      case 'ice-candidate':
        return this.handleBootstrapIceCandidate(request.controllerId, request.bootstrapId, request.candidate);
      case 'retry':
        return this.handleBootstrapRetry(request.controllerId, request.bootstrapId, request.runtime);
      default:
        return jsonResponse({ error: 'Invalid bootstrap request', code: 'INVALID_BOOTSTRAP_REQUEST' }, 400);
    }
  }

  private async handleControllerAttach(request: Request, token: string, url: URL): Promise<Response> {
    const tray = this.requireTray();
    if (!this.matchesToken(token, tray.controllerToken)) {
      return jsonResponse({ error: 'Invalid controller capability', code: 'INVALID_CONTROLLER_CAPABILITY' }, 403);
    }

    const attach = await this.readAttachRequest(request, url);
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
        return jsonResponse({ error: 'Leader is already connected', code: 'LEADER_ALREADY_CONNECTED' }, 409);
      }
      role = 'leader';
      tray.leader.controllerId = controllerId;
      tray.leader.lastSeenAt = nowIso;
      tray.leader.disconnectedAt = undefined;
      leaderKey = tray.leader.leaderKey;
    } else if (!tray.leader.connected && tray.leader.controllerId === controllerId) {
      return jsonResponse({
        error: 'Leader reclaim requires the previously issued leader key',
        code: 'LEADER_KEY_REQUIRED',
      }, 409);
    }

    await this.persistTray();

    return jsonResponse({
      trayId: tray.trayId,
      controllerId,
      role,
      leaderKey,
      leader: this.leaderSummary(),
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
      return jsonResponse({ error: 'Invalid controller capability', code: 'INVALID_CONTROLLER_CAPABILITY' }, 403);
    }
    if (!tray.leader) {
      return jsonResponse({ error: 'No leader has been elected', code: 'LEADER_NOT_ELECTED' }, 409);
    }

    const controllerId = url.searchParams.get('controllerId');
    const leaderKey = url.searchParams.get('leaderKey');
    if (!controllerId || !leaderKey) {
      return jsonResponse({
        error: 'controllerId and leaderKey are required for the leader WebSocket',
        code: 'LEADER_WEBSOCKET_AUTH_REQUIRED',
      }, 400);
    }
    if (leaderKey !== tray.leader.leaderKey || controllerId !== tray.leader.controllerId) {
      return jsonResponse({ error: 'Only the elected leader may open the tray WebSocket', code: 'LEADER_ONLY' }, 403);
    }
    if (tray.leader.connected && this.leaderSocket) {
      return jsonResponse({ error: 'Leader WebSocket already connected', code: 'LEADER_SOCKET_EXISTS' }, 409);
    }

    const { client, server } = this.webSocketPairFactory();
    server.accept?.();
    this.leaderSocket = server;
    tray.leader.connected = true;
    tray.leader.lastSeenAt = this.isoNow();
    tray.leader.disconnectedAt = undefined;

    server.addEventListener('message', event => {
      void this.handleLeaderMessage(server, event.data ?? '');
    });
    server.addEventListener('close', () => {
      void this.markLeaderDisconnected(server);
    });
    server.addEventListener('error', () => {
      void this.markLeaderDisconnected(server);
    });

    await this.persistTray();
    server.send(
      JSON.stringify({
        type: 'leader.connected',
        trayId: tray.trayId,
        controllerId,
      }),
    );

    return websocketResponse(client);
  }

  private async handleWebhook(token: string, request: Request, webhookId?: string): Promise<Response> {
    if (!this.matchesToken(token, this.requireTray().webhookToken)) {
      return jsonResponse({ error: 'Invalid webhook capability', code: 'INVALID_WEBHOOK_CAPABILITY' }, 403, {
        'access-control-allow-origin': '*',
      });
    }

    if (!webhookId) {
      return jsonResponse(
        {
          error: 'Webhook ID is required. Use POST /webhook/{token}/{webhookId}',
          code: 'WEBHOOK_ID_REQUIRED',
        },
        400,
        { 'access-control-allow-origin': '*' },
      );
    }

    if (!this.hasLiveLeader()) {
      return jsonResponse(
        {
          error: 'No live leader is connected for this tray',
          code: 'NO_LIVE_LEADER',
        },
        410,
        { 'access-control-allow-origin': '*' },
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

    // Collect relevant headers (skip Cloudflare-internal headers and host)
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      if (!key.startsWith('cf-') && key !== 'host') {
        headers[key] = value;
      }
    }

    // Forward to leader via the control WebSocket
    const sent = this.sendToLeader({
      type: 'webhook.event',
      webhookId,
      headers,
      body,
      timestamp: this.isoNow(),
    });

    if (!sent) {
      return jsonResponse(
        {
          error: 'Failed to forward webhook to leader',
          code: 'LEADER_SEND_FAILED',
        },
        502,
        { 'access-control-allow-origin': '*' },
      );
    }

    return jsonResponse(
      { ok: true, accepted: true },
      202,
      { 'access-control-allow-origin': '*' },
    );
  }

  private async handleLeaderMessage(socket: TrayWebSocketLike, raw: string): Promise<void> {
    if (socket !== this.leaderSocket || !this.tray?.leader) {
      return;
    }

    try {
      const message = JSON.parse(raw) as LeaderToWorkerControlMessage;
      this.tray.leader.lastSeenAt = this.isoNow();

      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', trayId: this.tray.trayId }));
      } else if (message.type === 'bootstrap.offer') {
        const bootstrap = this.findBootstrap(message.controllerId, message.bootstrapId);
        if (!bootstrap) {
          socket.send(JSON.stringify({ type: 'error', code: 'BOOTSTRAP_NOT_FOUND', bootstrapId: message.bootstrapId }));
        } else {
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
      } else if (message.type === 'bootstrap.ice_candidate') {
        const bootstrap = this.findBootstrap(message.controllerId, message.bootstrapId);
        if (!bootstrap) {
          socket.send(JSON.stringify({ type: 'error', code: 'BOOTSTRAP_NOT_FOUND', bootstrapId: message.bootstrapId }));
        } else {
          this.refreshBootstrapState(bootstrap);
          if (bootstrap.state !== 'failed') {
            this.appendBootstrapEvent(bootstrap, {
              type: 'bootstrap.ice_candidate',
              candidate: message.candidate,
            });
          }
        }
      } else if (message.type === 'bootstrap.failed') {
        const bootstrap = this.findBootstrap(message.controllerId, message.bootstrapId);
        if (!bootstrap) {
          socket.send(JSON.stringify({ type: 'error', code: 'BOOTSTRAP_NOT_FOUND', bootstrapId: message.bootstrapId }));
        } else {
          this.failBootstrap(bootstrap, {
            code: message.code,
            message: message.message,
            retryable: message.retryable ?? this.canRetryBootstrap(bootstrap),
            retryAfterMs: message.retryable === false ? null : message.retryAfterMs ?? TRAY_BOOTSTRAP_RETRY_AFTER_MS,
          });
        }
      }

      await this.persistTray();
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
    await this.persistTray();
  }

  private hasLiveLeader(): boolean {
    return Boolean(this.tray?.leader?.connected && this.leaderSocket);
  }

  private leaderSummary(): TrayLeaderSummary | null {
    const leader = this.requireTray().leader;
    if (!leader) {
      return null;
    }

    return {
      controllerId: leader.controllerId,
      connected: leader.connected && Boolean(this.leaderSocket),
      reconnectDeadline: leader.disconnectedAt
        ? new Date(Date.parse(leader.disconnectedAt) + TRAY_RECLAIM_TTL_MS).toISOString()
        : null,
    };
  }

  private async handleBootstrapPoll(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    cursor: number,
  ): Promise<Response> {
    const bootstrap = this.findBootstrap(controllerId, bootstrapId);
    if (!bootstrap) {
      return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
    }

    this.refreshBootstrapState(bootstrap);
    await this.persistTray();
    return this.buildFollowerBootstrapResponse(bootstrap, this.getBootstrapEventsAfter(bootstrap, cursor));
  }

  private async handleBootstrapAnswer(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    answer: TraySessionDescription | undefined,
  ): Promise<Response> {
    if (!this.isSessionDescription(answer, 'answer')) {
      return jsonResponse({ error: 'A valid bootstrap answer is required', code: 'INVALID_BOOTSTRAP_REQUEST' }, 400);
    }

    const bootstrap = this.findBootstrap(controllerId, bootstrapId);
    if (!bootstrap) {
      return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
    }

    this.refreshBootstrapState(bootstrap);
    if (bootstrap.state === 'failed') {
      await this.persistTray();
      return this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    if (!this.sendToLeader({
      type: 'bootstrap.answer',
      trayId: this.requireTray().trayId,
      controllerId: bootstrap.controllerId,
      bootstrapId: bootstrap.bootstrapId,
      answer,
    })) {
      this.failBootstrap(bootstrap, {
        code: 'LEADER_NOT_CONNECTED',
        message: 'Leader control channel is not connected',
        retryable: this.canRetryBootstrap(bootstrap),
        retryAfterMs: this.canRetryBootstrap(bootstrap) ? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null,
      });
      await this.persistTray();
      return this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    bootstrap.state = 'connected';
    bootstrap.failure = null;
    bootstrap.updatedAt = this.isoNow();
    await this.persistTray();
    return this.buildFollowerBootstrapResponse(bootstrap, []);
  }

  private async handleBootstrapIceCandidate(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    candidate: TrayIceCandidate | undefined,
  ): Promise<Response> {
    if (!this.isIceCandidate(candidate)) {
      return jsonResponse({ error: 'A valid ICE candidate is required', code: 'INVALID_BOOTSTRAP_REQUEST' }, 400);
    }

    const bootstrap = this.findBootstrap(controllerId, bootstrapId);
    if (!bootstrap) {
      return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
    }

    this.refreshBootstrapState(bootstrap);
    if (bootstrap.state === 'failed') {
      await this.persistTray();
      return this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    if (!this.sendToLeader({
      type: 'bootstrap.ice_candidate',
      trayId: this.requireTray().trayId,
      controllerId: bootstrap.controllerId,
      bootstrapId: bootstrap.bootstrapId,
      candidate,
    })) {
      this.failBootstrap(bootstrap, {
        code: 'LEADER_NOT_CONNECTED',
        message: 'Leader control channel is not connected',
        retryable: this.canRetryBootstrap(bootstrap),
        retryAfterMs: this.canRetryBootstrap(bootstrap) ? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null,
      });
      await this.persistTray();
      return this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    bootstrap.updatedAt = this.isoNow();
    await this.persistTray();
    return this.buildFollowerBootstrapResponse(bootstrap, []);
  }

  private async handleBootstrapRetry(
    controllerId: string | undefined,
    bootstrapId: string | undefined,
    runtime: string | undefined,
  ): Promise<Response> {
    const bootstrap = this.findBootstrap(controllerId, bootstrapId);
    if (!bootstrap) {
      return jsonResponse({ error: 'Bootstrap not found', code: 'BOOTSTRAP_NOT_FOUND' }, 404);
    }

    this.refreshBootstrapState(bootstrap);
    if (
      bootstrap.state !== 'failed'
      || !bootstrap.failure?.retryable
      || !this.canRetryBootstrap(bootstrap)
      || !this.hasLiveLeader()
    ) {
      await this.persistTray();
      return this.buildFollowerBootstrapResponse(bootstrap, [], 409);
    }

    const retried = this.createBootstrap(bootstrap.controllerId, runtime ?? bootstrap.runtime, bootstrap.retryCount + 1, bootstrap.maxRetries);
    this.requireTray().bootstraps[retried.bootstrapId] = retried;
    this.notifyLeaderJoinRequested(retried);
    await this.persistTray();
    return this.buildFollowerBootstrapResponse(retried, []);
  }

  private ensureBootstrap(controllerId: string, runtime: string | undefined): TrayBootstrapRecord {
    const existing = this.findBootstrap(controllerId);
    if (existing) {
      this.refreshBootstrapState(existing);
      return existing;
    }

    const bootstrap = this.createBootstrap(controllerId, runtime);
    this.requireTray().bootstraps[bootstrap.bootstrapId] = bootstrap;
    this.notifyLeaderJoinRequested(bootstrap);
    return bootstrap;
  }

  private createBootstrap(
    controllerId: string,
    runtime: string | undefined,
    retryCount = 0,
    maxRetries = TRAY_BOOTSTRAP_MAX_RETRIES,
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
    };
  }

  private notifyLeaderJoinRequested(bootstrap: TrayBootstrapRecord): void {
    this.sendToLeader({
      type: 'follower.join_requested',
      trayId: this.requireTray().trayId,
      controllerId: bootstrap.controllerId,
      runtime: bootstrap.runtime,
      bootstrapId: bootstrap.bootstrapId,
      attempt: bootstrap.attempt,
      expiresAt: bootstrap.expiresAt,
    });
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

    return values
      .filter(bootstrap => bootstrap.controllerId === controllerId)
      .sort((left, right) => right.attempt - left.attempt || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null;
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
    failure: Omit<TrayBootstrapFailure, 'failedAt'> & { failedAt?: string },
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
    this.appendBootstrapEvent(bootstrap, {
      type: 'bootstrap.failed',
      failure: normalizedFailure,
    }, failedAt);
  }

  private appendBootstrapEvent(
    bootstrap: TrayBootstrapRecord,
    event: TrayBootstrapEventInput,
    sentAt = this.isoNow(),
  ): TrayBootstrapEvent {
    const nextEvent = {
      ...event,
      sequence: bootstrap.nextSequence,
      sentAt,
    } as TrayBootstrapEvent;
    bootstrap.nextSequence += 1;
    bootstrap.updatedAt = sentAt;
    bootstrap.events.push(nextEvent);
    return nextEvent;
  }

  private getBootstrapEventsAfter(bootstrap: TrayBootstrapRecord, cursor: number): TrayBootstrapEvent[] {
    const normalizedCursor = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
    return bootstrap.events.filter(event => event.sequence > normalizedCursor);
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
      retryAfterMs: bootstrap.failure?.retryable ? bootstrap.failure.retryAfterMs ?? TRAY_BOOTSTRAP_RETRY_AFTER_MS : null,
      failure: bootstrap.failure,
    };
  }

  private buildFollowerBootstrapResponse(
    bootstrap: TrayBootstrapRecord,
    events: TrayBootstrapEvent[],
    status = 200,
  ): Response {
    const tray = this.requireTray();
    const payload: FollowerBootstrapResponse = {
      trayId: tray.trayId,
      controllerId: bootstrap.controllerId,
      role: 'follower',
      leader: this.leaderSummary(),
      participantCount: Object.keys(tray.controllers).length,
      bootstrap: this.buildBootstrapStatus(bootstrap),
      events,
    };
    return jsonResponse(payload, status);
  }

  private canRetryBootstrap(bootstrap: TrayBootstrapRecord): boolean {
    return bootstrap.retryCount < bootstrap.maxRetries;
  }

  private buildFollowerAttachResponse(
    controllerId: string,
    result: FollowerAttachResult,
    status = 200,
  ): Response {
    const tray = this.requireTray();
    const payload: FollowerAttachResponse = {
      trayId: tray.trayId,
      controllerId,
      role: 'follower',
      leader: this.leaderSummary(),
      participantCount: Object.keys(tray.controllers).length,
      result,
    };
    return jsonResponse(payload, status);
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

    const expiresAt = Date.parse(tray.leader.disconnectedAt) + TRAY_RECLAIM_TTL_MS;
    if (this.now() <= expiresAt) {
      return null;
    }

    tray.expiredAt = this.isoNow();
    await this.persistTray();
    return jsonResponse(
      {
        error: 'Tray expired because the leader did not reclaim it within one hour',
        code: 'TRAY_EXPIRED',
      },
      410,
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
      const body = (await request.json()) as Record<string, unknown>;
      const controllerId = typeof body['controllerId'] === 'string' ? body['controllerId'] : queryAttach.controllerId;
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
        controllerId: typeof body?.['controllerId'] === 'string' ? body['controllerId'] : queryAttach.controllerId,
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
    expectedType: TraySessionDescription['type'],
  ): value is TraySessionDescription {
    return Boolean(value && value.type === expectedType && typeof value.sdp === 'string');
  }

  private isIceCandidate(value: TrayIceCandidate | undefined): value is TrayIceCandidate {
    return Boolean(value && typeof value.candidate === 'string');
  }

  private buildLeaderWebSocketUrl(url: URL, controllerId: string, leaderKey: string): string {
    const webSocketUrl = new URL(url.pathname, `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`);
    webSocketUrl.searchParams.set('controllerId', controllerId);
    webSocketUrl.searchParams.set('leaderKey', leaderKey);
    return webSocketUrl.toString();
  }

  private matchesToken(received: string, expected: string): boolean {
    return received === expected;
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

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}