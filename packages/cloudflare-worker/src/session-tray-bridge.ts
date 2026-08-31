/**
 * Preview-bridge WebSocket relay.
 *
 * A driveable preview (`serve --bridge`) loads a shim that dials
 * `wss://<token>.sliccy.now/__slicc/bridge`. Each visitor tab gets one socket
 * on the tray DO, and this relay shuttles CDP requests leader→tab, CDP
 * responses and events tab→leader, and attributed `window.slicc.emit()` calls
 * tab→leader as webhook events.
 *
 * **Everything arriving on a bridge socket is untrusted third-party traffic.**
 * Frames are parsed defensively (a throw out of a hibernatable handler resets
 * the DO and drops the tray), emits are size- and rate-bounded before they can
 * reach the agent's context, and a frame whose socket attachment lost its
 * `connId` is dropped rather than guessed at.
 *
 * Extracted from `SessionTrayDurableObject` behind a {@link BridgeDeps} seam
 * (issue #2674), mirroring `session-tray-preview.ts`.
 */

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

/** Socket tag every bridge visitor socket carries, alongside `tok:` and `conn:`. */
export const BRIDGE_WS_TAG = 'bridge';

// Untrusted `window.slicc.emit()` frames arrive over the bridge WS and are
// forwarded verbatim into the cone's context. Bound both the per-frame size and
// the per-connection rate so a hostile preview visitor can't flood the agent
// with attacker-controlled text (token DoS / prompt-injection amplifier). The
// counter is per live DO instance — good enough because an active flood keeps
// the DO awake, and an idle reset between floods is harmless.
const MAX_BRIDGE_EMIT_BYTES = 16 * 1024;
const BRIDGE_EMIT_WINDOW_MS = 10_000;
const MAX_BRIDGE_EMITS_PER_WINDOW = 20;

/** Metadata stamped onto a bridge socket at accept time and read back after hibernation. */
interface BridgeAttachment {
  connId?: string;
  previewToken?: string;
  origin?: string;
  userAgent?: string;
  connectedAt?: string;
}

/** A frame from a visitor tab. Every field is re-validated before use. */
interface BridgeFrame {
  t?: string;
  id: number;
  result?: CDPPayload;
  error?: { code: number; message: string };
  name?: string;
  detail?: unknown;
}

/** The slice of the durable object this relay needs. */
export interface BridgeDeps {
  /** Live sockets carrying `tag`. Empty when the runtime has no hibernation API. */
  socketsWithTag(tag: string): TrayWebSocketLike[];
  tagsFor(ws: TrayWebSocketLike): string[];
  acceptWebSocket(ws: TrayWebSocketLike, tags: string[]): void;
  newWebSocketPair(): { client: unknown; server: TrayWebSocketLike };
  ensureAutoResponse(): void;
  loadTray(): Promise<void>;
  /** Re-attach the hibernation-evicted leader socket before relaying to it. */
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
  /**
   * Per-bridge-connection emit rate-limiter (fixed window), keyed by connId.
   * Evicted when the bridge socket closes/errors.
   */
  private readonly emitWindows = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly deps: BridgeDeps) {}

  /** Accept a visitor tab's bridge socket, or refuse it. */
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
    // Ensure tray and leader socket are available before sending notification
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

  /**
   * An inbound frame on a bridge socket. Relays CDP responses/events and
   * attributed `window.slicc.emit()` events to the leader; silently drops
   * anything malformed.
   */
  async handleMessage(ws: TrayWebSocketLike, message: string | ArrayBuffer): Promise<void> {
    await this.deps.loadTray();
    this.deps.restoreLeaderSocket();
    const { connId, previewToken } = attachmentOf(ws);
    // The attachment must carry the connId (set at accept time); without it we
    // can't route the frame back to the right leader-side transport. Drop it.
    if (!connId) return;
    const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
    // A malformed / non-JSON frame must not throw out of this hibernatable
    // handler — that would reset the DO and drop the tray.
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

  /**
   * `window.slicc.emit()` over the bridge WS. The DO knows the origin
   * connection (connId + previewToken from the socket attachment), so it
   * ATTRIBUTES the event: routed as the record's webhook.event with the
   * preview identity in headers, so the cone knows which tab fired it (the
   * matching drive target is `preview:<token>:<connId>`) and can tell a
   * preview event apart from a plain webhook. Unattributed beacon emits (the
   * page-unload fallback) go through handlePreviewEmit instead.
   *
   * Bound size + rate first: this is untrusted third-party traffic that lands
   * verbatim in the agent's context.
   */
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
      // No webhook to route to: the preview was revoked mid-flight (revoke
      // deletes the webhook and closes sockets, but an in-flight frame can still
      // arrive) or was never bridged with a provisioned webhook. The sibling
      // beacon path returns 400 here; a WS frame can only be logged.
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
    // A WS frame has no response channel, so unlike the beacon path (which
    // returns 502) we can't signal the page. Log the drop — this is the only
    // trace when a live leader momentarily vanishes mid-session.
    if (!delivered) {
      console.warn('[bridge] emit dropped: no live leader', { connId, previewToken });
    }
  }

  /**
   * Fixed-window rate limit for `window.slicc.emit()` frames from one bridge
   * connection. Returns false (drop) once a connection exceeds
   * MAX_BRIDGE_EMITS_PER_WINDOW within BRIDGE_EMIT_WINDOW_MS.
   */
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

  /**
   * A bridge visitor socket ended (close or error). Notify the leader so it
   * drops the phantom `preview:` target, and evict the per-conn emit-rate window.
   */
  async handleSocketGone(ws: TrayWebSocketLike): Promise<void> {
    await this.deps.loadTray();
    this.deps.restoreLeaderSocket();
    const { connId } = attachmentOf(ws);
    if (connId) this.forget(connId);
  }

  /**
   * Leader→bridge: route a CDP request to the matching bridge socket by its
   * `conn:<connId>` tag (indexed lookup, not an O(n) scan). When the visitor tab
   * is gone (closed / revoked), fail the leader's pending call fast instead of
   * letting it burn the full CDP timeout, so it can drop the phantom transport.
   */
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

  /**
   * The leader closed a preview target: close that visitor's bridge socket and
   * tell the leader it's gone (a server-initiated close won't re-fire
   * webSocketClose in workerd, so we can't rely on the close handler).
   */
  closeConnection(connId: string): void {
    const target = this.socketForConn(connId);
    this.forget(connId);
    target?.close(1000, 'closed by leader');
  }

  /**
   * Send a `bridge.connected` for every live bridge socket to a specific leader
   * socket. Metadata comes from the socket attachment stamped at accept time
   * (connId / previewToken / origin / userAgent / connectedAt).
   */
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

  /** Tear down every visitor socket bridged to a preview that was just revoked. */
  closeSocketsForPreview(previewToken: string): void {
    for (const ws of this.socketsForPreview(previewToken)) {
      // A server-initiated `ws.close()` does NOT re-invoke webSocketClose in
      // workerd, so notify the leader and evict per-conn state HERE. Otherwise the
      // leader keeps a phantom `preview:` target that hangs every CDP call for the
      // 30s timeout. (A duplicate bridge.disconnected, should webSocketClose also
      // fire, is a harmless no-op on the leader's `if (!entry) return` path.)
      const { connId } = attachmentOf(ws);
      if (connId) this.forget(connId);
      ws.close(1000, 'preview revoked');
    }
  }

  /** Drop per-connection state and tell the leader the target is gone. */
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
