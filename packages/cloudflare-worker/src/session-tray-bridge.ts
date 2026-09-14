import type {
  CDPPayload,
  LeaderBridgeCdpRequest,
  WorkerToLeaderControlMessage,
} from '@slicc/shared-ts';
import {
  jsonResponse,
  type PreviewRecord,
  type TrayRecord,
  type TrayWebSocketLike,
  websocketResponse,
} from './shared.js';

export const BRIDGE_WS_TAG = 'bridge';

const MAX_BRIDGE_EMIT_BYTES = 16 * 1024;
const BRIDGE_EMIT_WINDOW_MS = 10_000;
const MAX_BRIDGE_EMITS_PER_WINDOW = 20;

interface BridgeAttachment {
  connId?: string;
  previewToken?: string;
  origin?: string;
  userAgent?: string;
  connectedAt?: string;
}

interface BridgeFrame {
  t?: string;
  id: number;
  result?: CDPPayload;
  error?: { code: number; message: string };
  name?: string;
  detail?: unknown;
}

export interface BridgeDeps {
  socketsWithTag(tag: string): TrayWebSocketLike[];
  tagsFor(ws: TrayWebSocketLike): string[];
  acceptWebSocket(ws: TrayWebSocketLike, tags: string[]): void;
  newWebSocketPair(): { client: unknown; server: TrayWebSocketLike };
  ensureAutoResponse(): void;
  loadTray(): Promise<void>;

  restoreLeaderSocket(): void;
  getTray(): TrayRecord | null;
  sendToLeader(message: WorkerToLeaderControlMessage): boolean;
  resolvePreview(previewToken: string): Promise<PreviewRecord | null>;
  isoNow(): string;
  now(): number;
}

function attachmentOf(ws: TrayWebSocketLike): BridgeAttachment {
  return (ws.deserializeAttachment?.() ?? {}) as BridgeAttachment;
}

export class BridgeRelay {
  private readonly emitWindows = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly deps: BridgeDeps) {}

  async handleWebSocket(previewToken: string, request: Request): Promise<Response> {
    const record = await this.deps.resolvePreview(previewToken);
    if (!record?.bridge) {
      return jsonResponse({ error: 'Bridge not enabled', code: 'BRIDGE_DISABLED' }, 403);
    }
    const existing = this.socketsForPreview(previewToken);
    if (existing.length >= (record.maxTabs ?? 20)) {
      return jsonResponse({ error: 'Too many bridged tabs', code: 'BRIDGE_CAP' }, 429);
    }

    const { client, server } = this.deps.newWebSocketPair();
    const connId = crypto.randomUUID();
    this.deps.acceptWebSocket(server, [BRIDGE_WS_TAG, `tok:${previewToken}`, `conn:${connId}`]);
    const origin = request.headers.get('origin') ?? '';
    const userAgent = request.headers.get('user-agent') ?? '';
    const connectedAt = this.deps.isoNow();
    server.serializeAttachment?.({ connId, previewToken, origin, userAgent, connectedAt });
    this.deps.ensureAutoResponse();
    server.send(JSON.stringify({ t: 'welcome', connId }));

    await this.deps.loadTray();
    this.deps.restoreLeaderSocket();
    this.deps.sendToLeader({
      type: 'bridge.connected',
      connId,
      previewToken,
      origin,
      userAgent,
      connectedAt,
    });
    return websocketResponse(client);
  }

  async handleMessage(ws: TrayWebSocketLike, message: string | ArrayBuffer): Promise<void> {
    await this.deps.loadTray();
    this.deps.restoreLeaderSocket();
    const { connId, previewToken } = attachmentOf(ws);

    if (!connId) return;
    const data = typeof message === 'string' ? message : new TextDecoder().decode(message);

    let frame: BridgeFrame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }

    if (frame.t === 'cdp.res') {
      this.deps.sendToLeader({
        type: 'bridge.cdp.response',
        connId,
        id: frame.id,
        result: frame.result,
        error: frame.error,
      });
    } else if (frame.t === 'emit') {
      this.handleEmit(frame, data, connId, previewToken);
    }
  }

  private handleEmit(
    frame: BridgeFrame,
    data: string,
    connId: string,
    previewToken: string | undefined
  ): void {
    if (data.length > MAX_BRIDGE_EMIT_BYTES) {
      console.warn('[bridge] emit dropped: payload too large', {
        connId,
        previewToken,
        bytes: data.length,
      });
      return;
    }
    if (!this.allowEmit(connId)) {
      console.warn('[bridge] emit dropped: rate limit exceeded', { connId, previewToken });
      return;
    }
    const record = previewToken ? this.deps.getTray()?.previews?.[previewToken] : undefined;
    if (!record?.webhookId) {
      console.warn('[bridge] emit dropped: preview has no webhookId', {
        connId,
        previewToken,
        hasRecord: Boolean(record),
      });
      return;
    }
    const delivered = this.deps.sendToLeader({
      type: 'webhook.event',
      webhookId: record.webhookId,
      headers: {
        'x-slicc-preview-conn': connId,
        'x-slicc-preview-token': previewToken ?? '',
      },
      body: { name: frame.name, detail: frame.detail },
      timestamp: new Date(this.deps.now()).toISOString(),
    });

    if (!delivered) {
      console.warn('[bridge] emit dropped: no live leader', { connId, previewToken });
    }
  }

  private allowEmit(connId: string): boolean {
    const now = this.deps.now();
    const win = this.emitWindows.get(connId);
    if (!win || now - win.windowStart >= BRIDGE_EMIT_WINDOW_MS) {
      this.emitWindows.set(connId, { windowStart: now, count: 1 });
      return true;
    }
    if (win.count >= MAX_BRIDGE_EMITS_PER_WINDOW) return false;
    win.count += 1;
    return true;
  }

  async handleSocketGone(ws: TrayWebSocketLike): Promise<void> {
    await this.deps.loadTray();
    this.deps.restoreLeaderSocket();
    const { connId } = attachmentOf(ws);
    if (connId) this.forget(connId);
  }

  relayCdpRequest(message: LeaderBridgeCdpRequest): void {
    const target = this.socketForConn(message.connId);
    if (!target) {
      this.deps.sendToLeader({
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

  closeConnection(connId: string): void {
    const target = this.socketForConn(connId);
    this.forget(connId);
    target?.close(1000, 'closed by leader');
  }

  replayConnectionsToLeader(leaderWs: TrayWebSocketLike): void {
    for (const ws of this.deps.socketsWithTag(BRIDGE_WS_TAG)) {
      const att = attachmentOf(ws);
      if (!att.connId || !att.previewToken) continue;
      leaderWs.send(
        JSON.stringify({
          type: 'bridge.connected',
          connId: att.connId,
          previewToken: att.previewToken,
          origin: att.origin ?? '',
          userAgent: att.userAgent ?? '',
          connectedAt: att.connectedAt ?? this.deps.isoNow(),
          replay: true,
        })
      );
    }
  }

  closeSocketsForPreview(previewToken: string, transferred = false): void {
    for (const ws of this.socketsForPreview(previewToken)) {
      const { connId } = attachmentOf(ws);
      if (connId) this.forget(connId);
      ws.close(
        transferred ? 1012 : 1000,
        transferred ? 'preview moved; reconnect' : 'preview revoked'
      );
    }
  }

  private forget(connId: string): void {
    this.emitWindows.delete(connId);
    this.deps.sendToLeader({ type: 'bridge.disconnected', connId });
  }

  private socketForConn(connId: string): TrayWebSocketLike | undefined {
    return this.deps.socketsWithTag(`conn:${connId}`)[0];
  }

  private socketsForPreview(previewToken: string): TrayWebSocketLike[] {
    return this.deps
      .socketsWithTag(BRIDGE_WS_TAG)
      .filter((ws) => this.deps.tagsFor(ws).includes(`tok:${previewToken}`));
  }
}
