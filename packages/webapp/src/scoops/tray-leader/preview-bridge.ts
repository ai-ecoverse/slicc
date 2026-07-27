import type {
  WorkerBridgeCdpResponse,
  WorkerBridgeConnected,
  WorkerBridgeDisconnected,
} from '@slicc/shared-ts';
import { PreviewBridgeCdpTransport } from '../../cdp/preview-bridge-cdp-transport.js';
import type { LickEvent } from '../lick-manager.js';
import type { TrayTargetEntry } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

const PREVIEW_LICK_THROTTLE_MS = 2000;

interface BridgeConnection {
  previewToken: string;
  origin: string;
  userAgent: string;
  connectedAt: string;
  url: string;
  title: string;
  quiet: boolean;
  transport: PreviewBridgeCdpTransport;
}

interface PreviewConnectionLifecycle {
  connId: string;
  previewToken: string;
  origin: string;
  userAgent: string;
  connectedAt: string;
  quiet: boolean;
}

export class PreviewBridgeManager {
  readonly mintMap = new Map<string, { url: string; title: string; quiet: boolean }>();
  readonly bridgeConns = new Map<string, BridgeConnection>();
  readonly previewLickLastEmitAt = new Map<string, number>();

  constructor(private readonly context: LeaderSyncContext) {}

  registerMintedPreview(
    previewToken: string,
    meta: { url: string; title: string; quiet: boolean }
  ): void {
    this.mintMap.set(previewToken, meta);
  }

  dropMintedPreview(previewToken: string): void {
    this.mintMap.delete(previewToken);
    this.previewLickLastEmitAt.delete(`${previewToken}:connected`);
    this.previewLickLastEmitAt.delete(`${previewToken}:disconnected`);
  }

  onBridgeConnected(msg: WorkerBridgeConnected): void {
    const { connId, previewToken, origin, userAgent, connectedAt } = msg;
    if (this.bridgeConns.has(connId)) return;
    const mint = this.mintMap.get(previewToken);
    const url = mint?.url ?? origin;
    const title = mint?.title ?? 'Preview';
    const quiet = mint?.quiet ?? false;
    const transport = new PreviewBridgeCdpTransport({
      connId,
      targetUrl: url,
      targetOrigin: origin,
      title,
      send: (message) => this.context.sendControl(message),
    });
    void transport.connect();
    this.bridgeConns.set(connId, {
      previewToken,
      origin,
      userAgent,
      connectedAt,
      url,
      title,
      quiet,
      transport,
    });
    this.context.log.info('Preview bridge connected', { connId, previewToken, origin, userAgent });
    this.emitPreviewLifecycleLick('connected', {
      connId,
      previewToken,
      origin,
      userAgent,
      connectedAt,
      quiet,
    });
  }

  onBridgeDisconnected(msg: WorkerBridgeDisconnected): void {
    const { connId, reason } = msg;
    const entry = this.bridgeConns.get(connId);
    if (!entry) return;
    const { previewToken, origin, userAgent, connectedAt, quiet } = entry;
    entry.transport.disconnect();
    this.bridgeConns.delete(connId);
    this.context.log.info('Preview bridge disconnected', { connId, reason });
    this.emitPreviewLifecycleLick('disconnected', {
      connId,
      previewToken,
      origin,
      userAgent,
      connectedAt,
      quiet,
    });
  }

  onBridgeCdpResponse(msg: WorkerBridgeCdpResponse): void {
    const { connId, id, result, error } = msg;
    const entry = this.bridgeConns.get(connId);
    if (!entry) {
      this.context.log.warn('Received bridge.cdp.response for unknown connId', { connId, id });
      return;
    }
    entry.transport.deliverResponse(id, { result, error });
  }

  getBridgeTransport(connId: string): PreviewBridgeCdpTransport | undefined {
    return this.bridgeConns.get(connId)?.transport;
  }

  getTargetEntries(): TrayTargetEntry[] {
    return [...this.bridgeConns].map(([connId, entry]) => ({
      targetId: `preview:${entry.previewToken}:${connId}`,
      localTargetId: connId,
      runtimeId: 'preview',
      title: entry.title,
      url: entry.url,
      isLocal: false,
      kind: 'preview',
    }));
  }

  stop(): void {
    for (const entry of this.bridgeConns.values()) entry.transport.disconnect();
    this.bridgeConns.clear();
    this.mintMap.clear();
    this.previewLickLastEmitAt.clear();
  }

  private emitPreviewLifecycleLick(
    lifecycle: 'connected' | 'disconnected',
    conn: PreviewConnectionLifecycle
  ): void {
    if (conn.quiet || !this.context.options.onPreviewLick) return;
    const throttleKey = `${conn.previewToken}:${lifecycle}`;
    const now = Date.now();
    const lastEmit = this.previewLickLastEmitAt.get(throttleKey) ?? 0;
    if (now - lastEmit < PREVIEW_LICK_THROTTLE_MS) return;
    this.previewLickLastEmitAt.set(throttleKey, now);
    const event: LickEvent = {
      type: 'preview',
      previewLifecycle: lifecycle,
      previewConnId: conn.connId,
      previewToken: conn.previewToken,
      previewOrigin: conn.origin,
      previewUserAgent: conn.userAgent,
      previewConnectedAt: conn.connectedAt,
      timestamp: new Date().toISOString(),
      body: {},
    };
    try {
      this.context.options.onPreviewLick(event);
    } catch (err) {
      this.context.log.warn('onPreviewLick handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
