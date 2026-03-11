import {
  jsonResponse,
  TRAY_RECLAIM_TTL_MS,
  websocketResponse,
  type CreateTrayRequest,
  type DurableObjectStateLike,
  type TrayRecord,
} from './shared.js';

interface ControllerAttachRequest {
  controllerId?: string;
  leaderKey?: string;
  runtime?: string;
}

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

    const expiration = await this.ensureTrayIsActive();
    if (expiration) {
      return expiration;
    }

    const joinMatch = url.pathname.match(/^\/join\/([^/]+)$/);
    if (joinMatch) {
      return this.handleJoin(joinMatch[1]);
    }

    const controllerMatch = url.pathname.match(/^\/controller\/([^/]+)$/);
    if (controllerMatch) {
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return this.handleLeaderWebSocket(controllerMatch[1], url);
      }
      return this.handleControllerAttach(request, controllerMatch[1], url);
    }

    const webhookMatch = url.pathname.match(/^\/webhook\/([^/]+)$/);
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
      return this.handleWebhook(webhookMatch[1]);
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
      leader: null,
    };
    await this.persistTray();
    return jsonResponse(this.tray, 201);
  }

  private async handleJoin(token: string): Promise<Response> {
    if (!this.matchesToken(token, this.requireTray().joinToken)) {
      return jsonResponse({ error: 'Invalid join capability', code: 'INVALID_JOIN_CAPABILITY' }, 403);
    }

    return jsonResponse({
      trayId: this.requireTray().trayId,
      capability: 'join',
      leader: this.leaderSummary(),
      participantCount: Object.keys(this.requireTray().controllers).length,
    });
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

  private async handleWebhook(token: string): Promise<Response> {
    if (!this.matchesToken(token, this.requireTray().webhookToken)) {
      return jsonResponse({ error: 'Invalid webhook capability', code: 'INVALID_WEBHOOK_CAPABILITY' }, 403, {
        'access-control-allow-origin': '*',
      });
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

    return jsonResponse(
      {
        error: 'Webhook forwarding to the live leader is deferred to a later phase',
        code: 'WEBHOOK_FORWARDING_NOT_IMPLEMENTED',
      },
      501,
      { 'access-control-allow-origin': '*' },
    );
  }

  private async handleLeaderMessage(socket: TrayWebSocketLike, raw: string): Promise<void> {
    if (socket !== this.leaderSocket || !this.tray?.leader) {
      return;
    }

    this.tray.leader.lastSeenAt = this.isoNow();
    await this.persistTray();

    try {
      const message = JSON.parse(raw) as { type?: string };
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', trayId: this.tray.trayId }));
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
    await this.persistTray();
  }

  private hasLiveLeader(): boolean {
    return Boolean(this.tray?.leader?.connected && this.leaderSocket);
  }

  private leaderSummary(): { controllerId: string; connected: boolean; reconnectDeadline: string | null } | null {
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
    this.tray = (await this.state.storage.get<TrayRecord>(TRAY_STORAGE_KEY)) ?? null;
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