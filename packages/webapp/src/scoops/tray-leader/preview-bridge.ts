import type {
  WorkerBridgeCdpResponse,
  WorkerBridgeConnected,
  WorkerBridgeDisconnected,
} from '@slicc/shared-ts';
import { PreviewBridgeCdpTransport } from '../../cdp/preview-bridge-cdp-transport.js';
import type { LickEvent } from '../lick-manager.js';
import type { TrayTargetEntry } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

/** Maximum preview lifecycle records retained by one leader, oldest-first. */
export const PREVIEW_LIFECYCLE_RECORD_CAP = 500;

export interface PreviewLifecycleRecord {
  readonly timestamp: string;
  readonly lifecycle: 'connected' | 'disconnected';
  readonly connId: string;
  readonly previewToken?: string;
  readonly origin?: string;
  readonly userAgent?: string;
  readonly connectedAt?: string;
  readonly reason?: string;
  readonly announced: boolean;
}

export interface MintedPreview {
  url: string;
  title: string;
  quiet: boolean;
  announced: boolean;
}

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

export class PreviewBridgeManager {
  readonly mintMap = new Map<string, MintedPreview>();
  readonly bridgeConns = new Map<string, BridgeConnection>();
  private lifecycleRecords: PreviewLifecycleRecord[] = [];
  private lifecycleRecordStart = 0;
  private lifecycleRecordCount = 0;

  constructor(private readonly context: LeaderSyncContext) {}

  registerMintedPreview(
    previewToken: string,
    meta: { url: string; title: string; quiet: boolean }
  ): void {
    const announced = this.mintMap.get(previewToken)?.announced ?? false;
    this.mintMap.set(previewToken, { ...meta, announced });
  }

  dropMintedPreview(previewToken: string): void {
    this.mintMap.delete(previewToken);
    this.clearPreviewLifecycleRecords(previewToken);
  }

  onBridgeConnected(msg: WorkerBridgeConnected): void {
    const { connId, previewToken, origin, userAgent, connectedAt } = msg;
    const replay = msg.replay === true;
    const mint = replay
      ? (this.mintMap.get(previewToken) ?? {
          url: origin,
          title: 'Preview',
          quiet: false,
          announced: false,
        })
      : this.getOrCreatePreview(previewToken, origin);
    if (this.bridgeConns.has(connId)) {
      if (replay) return;
      this.recordLifecycle({
        timestamp: new Date().toISOString(),
        lifecycle: 'connected',
        connId,
        previewToken,
        origin,
        userAgent,
        connectedAt,
        announced: false,
      });
      return;
    }
    const { url, title, quiet } = mint;
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
    if (replay) return;
    const timestamp = new Date().toISOString();
    const announced = !mint.announced && !quiet && Boolean(this.context.options.onPreviewLick);
    mint.announced = true;
    this.recordLifecycle({
      timestamp,
      lifecycle: 'connected',
      connId,
      previewToken,
      origin,
      userAgent,
      connectedAt,
      announced,
    });
    if (announced) this.emitPreviewConnectedLick(msg, timestamp);
  }

  onBridgeDisconnected(msg: WorkerBridgeDisconnected): void {
    const { connId, reason } = msg;
    const entry = this.bridgeConns.get(connId);
    if (!entry) {
      this.recordLifecycle({
        timestamp: new Date().toISOString(),
        lifecycle: 'disconnected',
        connId,
        reason,
        announced: false,
      });
      return;
    }
    const { previewToken, origin, userAgent, connectedAt } = entry;
    entry.transport.disconnect();
    this.bridgeConns.delete(connId);
    this.context.log.info('Preview bridge disconnected', { connId, reason });
    this.recordLifecycle({
      timestamp: new Date().toISOString(),
      lifecycle: 'disconnected',
      connId,
      previewToken,
      origin,
      userAgent,
      connectedAt,
      reason,
      announced: false,
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
    this.resetLifecycleRecords();
  }

  getPreviewLifecycleRecords(previewToken?: string): readonly PreviewLifecycleRecord[] {
    return this.snapshotLifecycleRecords()
      .filter((record) => previewToken === undefined || record.previewToken === previewToken)
      .map((record) => ({ ...record }));
  }

  clearPreviewLifecycleRecords(previewToken?: string): number {
    const records = this.snapshotLifecycleRecords();
    const kept = records.filter(
      (record) => previewToken !== undefined && record.previewToken !== previewToken
    );
    const cleared = records.length - kept.length;
    this.resetLifecycleRecords();
    for (const record of kept) this.recordLifecycle(record);
    return cleared;
  }

  rearmPreviewAnnouncements(previewToken?: string): number {
    let rearmed = 0;
    for (const [token, preview] of this.mintMap) {
      if (previewToken !== undefined && token !== previewToken) continue;
      preview.announced = false;
      rearmed += 1;
    }
    return rearmed;
  }

  private getOrCreatePreview(previewToken: string, origin: string): MintedPreview {
    const existing = this.mintMap.get(previewToken);
    if (existing) return existing;
    const preview = { url: origin, title: 'Preview', quiet: false, announced: false };
    this.mintMap.set(previewToken, preview);
    return preview;
  }

  private emitPreviewConnectedLick(conn: WorkerBridgeConnected, timestamp: string): void {
    const event: LickEvent = {
      type: 'preview',
      previewLifecycle: 'connected',
      previewConnId: conn.connId,
      previewToken: conn.previewToken,
      previewOrigin: conn.origin,
      previewUserAgent: conn.userAgent,
      previewConnectedAt: conn.connectedAt,
      timestamp,
      body: {},
    };
    try {
      this.context.options.onPreviewLick?.(event);
    } catch (err) {
      this.context.log.warn('onPreviewLick handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private recordLifecycle(record: PreviewLifecycleRecord): void {
    if (this.lifecycleRecordCount < PREVIEW_LIFECYCLE_RECORD_CAP) {
      const index =
        (this.lifecycleRecordStart + this.lifecycleRecordCount) % PREVIEW_LIFECYCLE_RECORD_CAP;
      this.lifecycleRecords[index] = record;
      this.lifecycleRecordCount += 1;
      return;
    }
    this.lifecycleRecords[this.lifecycleRecordStart] = record;
    this.lifecycleRecordStart = (this.lifecycleRecordStart + 1) % PREVIEW_LIFECYCLE_RECORD_CAP;
  }

  private snapshotLifecycleRecords(): PreviewLifecycleRecord[] {
    return Array.from({ length: this.lifecycleRecordCount }, (_, offset) => {
      const index = (this.lifecycleRecordStart + offset) % PREVIEW_LIFECYCLE_RECORD_CAP;
      return this.lifecycleRecords[index]!;
    });
  }

  private resetLifecycleRecords(): void {
    this.lifecycleRecords = [];
    this.lifecycleRecordStart = 0;
    this.lifecycleRecordCount = 0;
  }
}
