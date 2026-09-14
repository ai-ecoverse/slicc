import { createLogger } from '../base/logger.js';
import {
  type CdpBridgeOptions,
  CdpTransportBridge,
  type ParsedCdpEvent,
  type ParsedCdpResponse,
} from '../kernel/cdp-bridge.js';
import {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  type ExtensionBridgeDiscovery,
  type ExtensionBridgeEnvelope,
  type ExtensionBridgeLick,
  isBridgeVersionMismatch,
  isExtensionBridgeEnvelope,
} from './extension-bridge-protocol.js';
import type { CDPConnectOptions } from './types.js';

const log = createLogger('cdp:extension-bridge');

export interface ExtensionBridgePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface ExtensionBridgeTransportOptions {
  extensionId: string;

  connect?: (extensionId: string, info: { name: string }) => ExtensionBridgePort;

  handshakeTimeoutMs?: number;

  onLick?: (lick: ExtensionBridgeLick) => void;

  onDiscovery?: (discovery: ExtensionBridgeDiscovery) => void;

  onOpenSettings?: () => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT = 10000;

interface PortHolder {
  port: ExtensionBridgePort | null;
}

function defaultConnect(extensionId: string, info: { name: string }): ExtensionBridgePort {
  const runtime = (globalThis as unknown as { chrome?: { runtime?: unknown } }).chrome?.runtime as
    | { connect: (id: string, info: { name: string }) => ExtensionBridgePort }
    | undefined;
  if (!runtime?.connect) {
    throw new Error(
      'chrome.runtime.connect is not available in this realm — the page must be in the extension externally_connectable allowlist'
    );
  }
  return runtime.connect(extensionId, info);
}

export class ExtensionBridgeTransport extends CdpTransportBridge {
  readonly isExtensionBridge = true;

  private readonly bridgeOpts: ExtensionBridgeTransportOptions;
  private readonly channelId: string;
  private readonly portHolder: PortHolder;
  private resolveWelcome: (() => void) | null = null;
  private rejectWelcome: ((err: Error) => void) | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private lastJoinUrl: string | null = null;

  constructor(opts: ExtensionBridgeTransportOptions) {
    const channelId = `bridge-${crypto.randomUUID()}`;
    const portHolder: PortHolder = { port: null };
    super(buildBridgeOptions(channelId, portHolder));
    this.bridgeOpts = opts;
    this.channelId = channelId;
    this.portHolder = portHolder;
  }

  override async connect(options?: CDPConnectOptions): Promise<void> {
    this.intentionalDisconnect = false;
    const connectFn = this.bridgeOpts.connect ?? defaultConnect;
    const port = connectFn(this.bridgeOpts.extensionId, { name: EXTENSION_BRIDGE_PORT_NAME });
    this.portHolder.port = port;

    const welcomePromise = new Promise<void>((resolve, reject) => {
      this.resolveWelcome = resolve;
      this.rejectWelcome = reject;
    });

    port.onMessage.addListener((raw: unknown) => this.handleHandshake(raw));
    port.onDisconnect.addListener(() => this.handlePortDisconnect(port));

    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: this.channelId,
      kind: 'handshake.hello',
    });

    const timeoutMs =
      options?.timeout ?? this.bridgeOpts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT;
    this.welcomeTimer = setTimeout(() => {
      if (!this.rejectWelcome) return;
      this.rejectWelcome(new Error(`Extension bridge handshake timed out after ${timeoutMs}ms`));
      this.cleanupHandshake();
      try {
        port.disconnect();
      } catch {}
      this.portHolder.port = null;
    }, timeoutMs);

    await welcomePromise;
    await super.connect(options);

    if (this.lastJoinUrl !== null) {
      this.sendLeaderJoinUrl(this.lastJoinUrl);
    }
  }

  sendLeaderJoinUrl(joinUrl: string | null): void {
    this.lastJoinUrl = joinUrl;
    const port = this.portHolder.port;
    if (!port) return;
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: this.channelId,
      kind: 'leader.join-url',
      joinUrl,
    });
  }

  override disconnect(): void {
    this.intentionalDisconnect = true;
    this.cleanupHandshake();
    const port = this.portHolder.port;
    if (port) {
      try {
        port.disconnect();
      } catch {}
      this.portHolder.port = null;
    }
    super.disconnect();
  }

  private handlePortDisconnect(droppedPort: ExtensionBridgePort): void {
    if (this.portHolder.port !== droppedPort && this.portHolder.port !== null) return;
    this.portHolder.port = null;

    if (this.rejectWelcome) {
      this.rejectWelcome(new Error('Extension bridge port disconnected before welcome'));
      this.cleanupHandshake();
      return;
    }

    if (!this.intentionalDisconnect && this.state === 'connected') {
      super.disconnect();
    }
  }

  testReceive(raw: unknown): void {
    this.handleHandshake(raw);
  }

  private handleHandshake(raw: unknown): void {
    if (isBridgeVersionMismatch(raw)) {
      log.warn('Extension bridge protocol version mismatch — update the older side', {
        peerVersion: raw.bridge,
        ourVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      });

      if (raw.channelId === this.channelId && this.rejectWelcome) {
        this.rejectWelcome(
          new Error(
            `Extension bridge protocol version mismatch (peer v${raw.bridge}, ` +
              `ours v${EXTENSION_BRIDGE_PROTOCOL_VERSION}) — update the older side`
          )
        );
        this.cleanupHandshake();
      }
      return;
    }
    if (!isExtensionBridgeEnvelope(raw)) return;
    const env = raw as ExtensionBridgeEnvelope;
    if (env.channelId !== this.channelId) return;
    if (env.kind === 'handshake.welcome') {
      this.resolveWelcome?.();
      this.cleanupHandshake();
      return;
    }
    if (env.kind === 'handshake.rejected') {
      log.warn('Extension bridge handshake rejected', { reason: env.reason });
      this.rejectWelcome?.(new Error(`Extension bridge handshake rejected: ${env.reason}`));
      this.cleanupHandshake();
      return;
    }
    if (env.kind === 'cdp.event' && env.method === 'Target.detachedFromTarget') {
      this.disconnect();
      return;
    }
    if (env.kind === 'extension.lick') {
      this.bridgeOpts.onLick?.(env);
    }
    if (env.kind === 'extension.discovery') {
      this.bridgeOpts.onDiscovery?.(env);
    }
    if (env.kind === 'extension.open-settings') {
      this.bridgeOpts.onOpenSettings?.();
    }
  }

  private cleanupHandshake(): void {
    if (this.welcomeTimer !== null) {
      clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
    this.resolveWelcome = null;
    this.rejectWelcome = null;
  }
}

function buildBridgeOptions(channelId: string, holder: PortHolder): CdpBridgeOptions {
  return {
    label: 'ExtensionBridgeTransport',
    buildCommandEnvelope: (id, method, params, sessionId) => ({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.request' as const,
      id,
      method,
      params,
      sessionId,
    }),
    sendEnvelope: async (envelope) => {
      const port = holder.port;
      if (!port) throw new Error('Extension bridge port not connected');
      port.postMessage(envelope);
    },
    subscribeIncoming: (handler) => {
      const port = holder.port;

      if (!port) throw new Error('Extension bridge subscribeIncoming called without an open port');
      const listener = (msg: unknown): void => handler(msg);
      port.onMessage.addListener(listener);

      return () => {};
    },
    parseResponse: (envelope): ParsedCdpResponse | null => {
      if (!isExtensionBridgeEnvelope(envelope)) return null;
      const env = envelope as ExtensionBridgeEnvelope;
      if (env.channelId !== channelId) return null;
      if (env.kind !== 'cdp.response') return null;
      return { id: env.id, result: env.result, error: env.error };
    },
    parseEvent: (envelope): ParsedCdpEvent | null => {
      if (!isExtensionBridgeEnvelope(envelope)) return null;
      const env = envelope as ExtensionBridgeEnvelope;
      if (env.channelId !== channelId) return null;
      if (env.kind !== 'cdp.event') return null;
      const params = env.sessionId
        ? { ...(env.params ?? {}), sessionId: env.sessionId }
        : env.params;
      return { method: env.method, params };
    },
    onListenerError: (event, err) => {
      log.warn('Extension bridge listener error', {
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  };
}
