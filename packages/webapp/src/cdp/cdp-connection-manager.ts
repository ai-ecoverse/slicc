import {
  CdpBridgeRejectedError,
  type CdpConnectFailureClassifier,
  CdpReconnectBackoffError,
  nextCdpReconnectDelayMs,
} from './cdp-reconnect-policy.js';
import type { CDPTransport } from './transport.js';
import type { CDPConnectOptions } from './types.js';

const FALLBACK_CDP_URL = 'ws://localhost:5710/cdp';

export function getDefaultCdpUrl(
  locationLike: Pick<Location, 'protocol' | 'host'> | null = typeof window !== 'undefined'
    ? window.location
    : null
): string {
  if (!locationLike?.host) return FALLBACK_CDP_URL;
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/cdp`;
}

export interface EnsureConnectedHost {
  client: CDPTransport;

  restoreLocalAfterRemoteDrop: () => void;

  clearSessionsForTransport: (transport: CDPTransport) => void;

  getClient: () => CDPTransport;
}

export class CdpConnectionManager {
  private lastConnectOptions: Partial<CDPConnectOptions> | null = null;

  private supersededHandler: (() => void) | null = null;
  private supersededNotified = false;

  private reconnectAttempt = 0;
  private reconnectNotBefore = 0;

  private bridgeRejection: string | null = null;
  private bridgeRejectedHandler: (() => void) | null = null;
  private bridgeRejectedNotified = false;

  private classifyConnectFailure: CdpConnectFailureClassifier = async () => 'transient';

  primeConnectOptions(options?: Partial<CDPConnectOptions>): void {
    this.lastConnectOptions = options ? { ...options } : {};
  }

  setSupersededHandler(handler: (() => void) | null): void {
    this.supersededHandler = handler;
  }

  setBridgeRejectedHandler(handler: (() => void) | null): void {
    this.bridgeRejectedHandler = handler;
  }

  setConnectFailureClassifier(classifier: CdpConnectFailureClassifier): void {
    this.classifyConnectFailure = classifier;
  }

  async connect(client: CDPTransport, options?: Partial<CDPConnectOptions>): Promise<void> {
    if (this.bridgeRejection) {
      this.notifyBridgeRejected();
      throw new CdpBridgeRejectedError(this.bridgeRejection);
    }

    this.lastConnectOptions = options ? { ...options } : {};
    try {
      await client.connect({
        url: options?.url ?? getDefaultCdpUrl(),
        timeout: options?.timeout,
        ...(options?.protocols !== undefined ? { protocols: options.protocols } : {}),
      });
    } catch (err) {
      await this.noteReconnectFailure(options);
      if (this.bridgeRejection) throw new CdpBridgeRejectedError(this.bridgeRejection);
      throw err;
    }
    this.noteReconnectSuccess();
  }

  async ensureLocalConnected(localClient: CDPTransport): Promise<void> {
    if (localClient.superseded === true) {
      this.notifySuperseded();
      return;
    }
    if (localClient.state === 'disconnected') {
      this.throwIfReconnectPaused();
      const opts = this.lastConnectOptions;
      try {
        await localClient.connect({
          url: opts?.url ?? getDefaultCdpUrl(),
          ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(opts?.protocols !== undefined ? { protocols: opts.protocols } : {}),
        });
      } catch (err) {
        await this.noteReconnectFailure(opts ?? undefined);
        if (this.bridgeRejection) throw new CdpBridgeRejectedError(this.bridgeRejection);
        throw err;
      }
      this.noteReconnectSuccess();
    }
  }

  async ensureConnected(host: EnsureConnectedHost): Promise<void> {
    if (host.client.superseded === true) {
      this.notifySuperseded();
      return;
    }
    if (host.client.state === 'disconnected') {
      this.throwIfReconnectPaused();
      const dropped = host.client;

      host.restoreLocalAfterRemoteDrop();

      host.clearSessionsForTransport(dropped);
      if (host.getClient().state === 'disconnected') {
        await this.connect(host.getClient(), this.lastConnectOptions ?? undefined);
      }
    }
  }

  private throwIfReconnectPaused(): void {
    if (this.bridgeRejection) {
      this.notifyBridgeRejected();
      throw new CdpBridgeRejectedError(this.bridgeRejection);
    }
    if (Date.now() < this.reconnectNotBefore) throw new CdpReconnectBackoffError();
  }

  private noteReconnectSuccess(): void {
    this.reconnectAttempt = 0;
    this.reconnectNotBefore = 0;

    this.supersededNotified = false;
  }

  private async noteReconnectFailure(options?: Partial<CDPConnectOptions>): Promise<void> {
    const kind = await this.classifyConnectFailure({
      url: options?.url ?? '',
      ...(options?.protocols !== undefined ? { protocols: options.protocols } : {}),
    });
    if (kind === 'terminal') {
      this.bridgeRejection = new CdpBridgeRejectedError().message;
      this.notifyBridgeRejected();
      return;
    }
    const delay = nextCdpReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectNotBefore = Date.now() + delay;
  }

  private notifyBridgeRejected(): void {
    if (this.bridgeRejectedNotified) return;
    this.bridgeRejectedNotified = true;
    try {
      this.bridgeRejectedHandler?.();
    } catch {}
  }

  private notifySuperseded(): void {
    if (this.supersededNotified) return;
    this.supersededNotified = true;
    try {
      this.supersededHandler?.();
    } catch {}
  }
}
