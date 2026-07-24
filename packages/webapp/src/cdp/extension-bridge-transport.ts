/**
 * ExtensionBridgeTransport — `CDPTransport` implementation for the thin
 * extension, alongside `CDPClient` (WS/CLI) and `CherryHostTransport`
 * (synthetic CDP over postMessage).
 *
 * Runs INSIDE the sliccy.ai leader tab. Opens a long-lived Port to the
 * extension service worker via `chrome.runtime.connect(extensionId, { name:
 * EXTENSION_BRIDGE_PORT_NAME })` and gives the page full `chrome.debugger`
 * pass-through (navigate / screenshot / evaluate / Network.*).
 *
 * Wave-1 Spike B picked a long-lived Port (not `sendMessageExternal`) to
 * mirror the existing `fetch-proxy.fetch` connection — better for streaming
 * CDP events. The SW enforces the three-factor pin
 * (origin allowlist + `sender.tab.id === storedLeaderTabId` +
 * `sender.frameId === 0`) at `onConnectExternal`; this transport simply opens
 * the Port, runs the handshake, then delegates command/event plumbing to the
 * shared `CdpTransportBridge`.
 */

import { createLogger } from '../core/logger.js';
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

/** Minimal duck-typed view of `chrome.runtime.Port` we depend on. */
export interface ExtensionBridgePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface ExtensionBridgeTransportOptions {
  /**
   * Extension ID to connect to. Production is fixed by the manifest `key`;
   * dev (`SLICC_EXT_DEV=1`) is path-derived and discovered out of band (the
   * leader bootstrap is the sibling task's surface).
   */
  extensionId: string;
  /**
   * Open-port factory. Defaults to `chrome.runtime.connect`. Tests inject a
   * fake to drive the protocol without a real chrome runtime.
   */
  connect?: (extensionId: string, info: { name: string }) => ExtensionBridgePort;
  /** Handshake timeout in ms. Defaults to 10000. */
  handshakeTimeoutMs?: number;
  /**
   * Optional sink for `extension.lick` envelopes pushed SW → leader tab. The
   * SW observes a SLICC handoff `Link` header and forwards it over the
   * welcomed Port; this fires (channelId-matched) for each such envelope so
   * the leader bootstrap can inject a navigate `LickEvent` into the worker
   * `LickManager`. CDP plumbing is untouched — lick envelopes never reach the
   * CDP bridge's response/event parse path.
   */
  onLick?: (lick: ExtensionBridgeLick) => void;
  /**
   * Optional sink for `extension.discovery` envelopes pushed SW → leader tab.
   * The SW observes an agentic-resource-discovery artifact (an `ai-catalog`
   * `Link` rel or a well-known probe hit) and forwards it over the welcomed
   * Port; this fires (channelId-matched) for each such envelope so the leader
   * bootstrap can inject a `discovery` `LickEvent` into the worker
   * `LickManager`. Mirrors {@link onLick}; CDP plumbing is untouched.
   */
  onDiscovery?: (discovery: ExtensionBridgeDiscovery) => void;
  /**
   * Optional sink for `extension.open-settings` envelopes pushed SW → leader
   * tab. Fires when the extension side-panel follower hands a sign-in off to
   * this leader tab; the bootstrap opens the provider Settings dialog so the
   * user lands on it instead of a dead tab.
   */
  onOpenSettings?: () => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT = 10000;

/** Per-instance mutable holder for the live port; closures in the bridge
 *  options read it through a closure so we can swap the port across
 *  connect/disconnect without rebuilding the bridge. */
interface PortHolder {
  port: ExtensionBridgePort | null;
}

function defaultConnect(extensionId: string, info: { name: string }): ExtensionBridgePort {
  // The webapp page realm at sliccy.ai exposes `chrome.runtime.connect` when
  // the extension's manifest lists the origin under `externally_connectable`.
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
  /**
   * Marks this transport as the thin extension's `chrome.debugger` Port
   * bridge so the kernel host skips the CDP-level `NavigationWatcher`: the
   * bridge rejects sessionless `Target.*` discovery commands, and the
   * service worker already observes handoffs via `chrome.webRequest`. See
   * `CDPTransport.isExtensionBridge`.
   */
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

    // chrome.runtime.Port has no removeListener — these listeners live as
    // long as the port does. The CdpTransportBridge will register its own
    // listener through subscribeIncoming() inside super.connect() below.
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
      } catch {
        /* already gone */
      }
      this.portHolder.port = null;
    }, timeoutMs);

    await welcomePromise;
    await super.connect(options);
    // MV3: the SW can be evicted and lose its joinUrl cache while the tray
    // session (and this transport) stay alive. Replay on every (re)connect.
    if (this.lastJoinUrl !== null) {
      this.sendLeaderJoinUrl(this.lastJoinUrl);
    }
  }

  /** Push the leader's tray joinUrl to the SW so injected cherry sidebars can join. */
  sendLeaderJoinUrl(joinUrl: string | null): void {
    this.lastJoinUrl = joinUrl; // remembered so a Port reconnect can replay it
    const port = this.portHolder.port;
    if (!port) return; // not connected yet; replayed on the next successful connect()
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
      } catch {
        /* already gone */
      }
      this.portHolder.port = null;
    }
    super.disconnect();
  }

  /**
   * Port `onDisconnect` handler. Fires when the SW recycles or the extension
   * reloads, killing the long-lived Port. Pre-welcome it rejects the
   * handshake; post-welcome (unexpected) it transitions the bridge back to
   * `'disconnected'` so the next `BrowserAPI.ensureConnected()` re-dials a
   * fresh port + handshake with no page reload.
   */
  private handlePortDisconnect(droppedPort: ExtensionBridgePort): void {
    // chrome.runtime.Port has no removeListener, so a stale listener from a
    // replaced port can still fire — self-ignore when a newer port is live.
    if (this.portHolder.port !== droppedPort && this.portHolder.port !== null) return;
    this.portHolder.port = null;

    if (this.rejectWelcome) {
      this.rejectWelcome(new Error('Extension bridge port disconnected before welcome'));
      this.cleanupHandshake();
      return;
    }

    if (!this.intentionalDisconnect && this.state === 'connected') {
      // Base disconnect rejects pending commands, clears listeners, and sets
      // state to 'disconnected' (it never touches the port, so a dead port is
      // safe). disconnect() already ran this for the intentional path.
      super.disconnect();
    }
  }

  /** Test seam: inject a raw envelope as if the SW posted it. */
  testReceive(raw: unknown): void {
    this.handleHandshake(raw);
  }

  private handleHandshake(raw: unknown): void {
    if (isBridgeVersionMismatch(raw)) {
      // A skewed peer fails the structural validator — without this distinct
      // log the mismatch is indistinguishable from the handshake timeout.
      log.warn('Extension bridge protocol version mismatch — update the older side', {
        peerVersion: raw.bridge,
        ourVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      });
      // The Port peer is pinned (onConnectExternal + name), and the envelope
      // echoes our channelId — fail the pending connect() immediately instead
      // of letting the caller eat the handshake timeout.
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
      // CdpTransportBridge invokes subscribeIncoming() synchronously inside
      // its connect(); ExtensionBridgeTransport.connect() opens the port
      // BEFORE awaiting welcome and BEFORE calling super.connect(), so the
      // port is always live here. Fail-closed if not — the caller wired
      // something out of order.
      if (!port) throw new Error('Extension bridge subscribeIncoming called without an open port');
      const listener = (msg: unknown): void => handler(msg);
      port.onMessage.addListener(listener);
      // No removeListener on chrome.runtime.Port — port.disconnect() in
      // ExtensionBridgeTransport.disconnect() tears the listener down.
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
