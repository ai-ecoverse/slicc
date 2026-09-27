/**
 * CDP transport dialing, lazy reconnect, and superseded / bridge-rejected
 * notification.
 *
 * Extracted from {@link BrowserAPI} so reconnect backoff, option replay, and
 * once-per-episode banner wiring can be reasoned about (and unit-tested)
 * without the rest of the bridge. Session clearing and remote→local transport
 * restore stay on BrowserAPI; this module owns connect options, backoff
 * clocks, the failure classifier, and the notification flags.
 */

import {
  CdpBridgeRejectedError,
  type CdpConnectFailureClassifier,
  CdpReconnectBackoffError,
  nextCdpReconnectDelayMs,
} from './cdp-reconnect-policy.js';
import type { CDPTransport } from './transport.js';
import type { CDPConnectOptions } from './types.js';

const FALLBACK_CDP_URL = 'ws://localhost:5710/cdp';

/**
 * Default `/cdp` WebSocket URL for the current page origin.
 *
 * Hosted-leader pages have no `/cdp` — callers that dial without captured
 * connect options hit this and fail. Standalone boot and follower overlays
 * must {@link CdpConnectionManager.primeConnectOptions} (or call
 * {@link CdpConnectionManager.connect}) so lazy reconnects replay the local
 * bridge URL + subprotocol.
 */
export function getDefaultCdpUrl(
  locationLike: Pick<Location, 'protocol' | 'host'> | null = typeof window !== 'undefined'
    ? window.location
    : null
): string {
  if (!locationLike?.host) return FALLBACK_CDP_URL;
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/cdp`;
}

/**
 * BrowserAPI hooks that {@link CdpConnectionManager.ensureConnected} needs
 * when the active transport drops. Session registry and tray bookkeeping stay
 * on the host; the manager only sequences dial + backoff.
 */
export interface EnsureConnectedHost {
  /** Active transport when the drop was noticed (may be a remote tray transport). */
  client: CDPTransport;
  /**
   * If the dropped client was a remote transport, restore the local client and
   * clear remote bookkeeping. Called before sessions on the dropped transport
   * are cleared.
   */
  restoreLocalAfterRemoteDrop: () => void;
  /** Drop registry entries that lived on the disconnected transport. */
  clearSessionsForTransport: (transport: CDPTransport) => void;
  /** After restore, the current client may have changed — re-read it. */
  getClient: () => CDPTransport;
}

export class CdpConnectionManager {
  /**
   * Last-used connect options (url + protocols) captured on the first
   * successful (or attempted) {@link connect}. Lazy reconnects via
   * {@link ensureConnected} / {@link ensureLocalConnected} reuse this so the
   * bridge URL + subprotocol survive a transport drop — without it, a
   * thin-bridge reconnect would fall back to {@link getDefaultCdpUrl} and
   * try to hit `wss://<hosted-leader-host>/cdp`, which doesn't exist.
   */
  private lastConnectOptions: Partial<CDPConnectOptions> | null = null;
  /**
   * Fired once when the local CDP client is superseded by a newer client
   * (another SLICC tab/window on the same standalone instance). Boot wires
   * this to a user-facing banner. Standalone-only — extension `DebuggerClient`
   * has no `/cdp` proxy, so it never supersedes.
   */
  private supersededHandler: (() => void) | null = null;
  private supersededNotified = false;
  /**
   * Transient-failure backoff for lazy reconnects ({@link ensureConnected}).
   * {@link connect} itself still dials immediately so the boot race can retry
   * on its own short schedule; the gate stops the 5s target-refresh loop from
   * opening a WebSocket on every tick.
   */
  private reconnectAttempt = 0;
  private reconnectNotBefore = 0;
  /** Set when the bridge refused the token. Further dials cannot succeed. */
  private bridgeRejection: string | null = null;
  private bridgeRejectedHandler: (() => void) | null = null;
  private bridgeRejectedNotified = false;
  /**
   * Defaults to "transient" so unit tests that reject `connect()` do not
   * probe a live bridge. Standalone boot installs {@link classifyCdpConnectFailure}.
   */
  private classifyConnectFailure: CdpConnectFailureClassifier = async () => 'transient';

  /**
   * Record the connect options WITHOUT dialing the bridge.
   *
   * The Electron follower-overlay boot path deliberately skips the eager
   * `connect()` so multiple overlay tabs don't all race for the single-client
   * `/cdp` proxy slot. Priming here lets a later on-demand connect reach the
   * LOCAL bridge instead of falling back to {@link getDefaultCdpUrl}.
   */
  primeConnectOptions(options?: Partial<CDPConnectOptions>): void {
    this.lastConnectOptions = options ? { ...options } : {};
  }

  /**
   * Register a callback fired (once per episode) when the local CDP slot is
   * taken over by a newer client. Pass `null` to clear.
   */
  setSupersededHandler(handler: (() => void) | null): void {
    this.supersededHandler = handler;
  }

  /**
   * Fired once when the bridge refuses this tab's token. Pass `null` to clear.
   */
  setBridgeRejectedHandler(handler: (() => void) | null): void {
    this.bridgeRejectedHandler = handler;
  }

  /** Standalone boot installs the HTTP probe. Tests install a fake. */
  setConnectFailureClassifier(classifier: CdpConnectFailureClassifier): void {
    this.classifyConnectFailure = classifier;
  }

  /**
   * Connect to the CDP proxy on `client`.
   * `ExtensionBridgeTransport` (thin extension) ignores these options.
   */
  async connect(client: CDPTransport, options?: Partial<CDPConnectOptions>): Promise<void> {
    // An explicit connect (boot's bounded retry) dials even during the
    // backoff window. A rejected token does not: another handshake cannot
    // succeed until the tab is opened with the current token.
    if (this.bridgeRejection) {
      this.notifyBridgeRejected();
      throw new CdpBridgeRejectedError(this.bridgeRejection);
    }
    // Capture the connect options BEFORE attempting the connection so
    // subsequent lazy reconnects via `ensureConnected()` can replay the
    // same bridge URL + subprotocol even when the very first connect
    // racing against bridge startup failed.
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

  /**
   * Lazily connect (or reconnect) the local `/cdp` client.
   * A superseded client lost the single CDP proxy slot — re-dialing would
   * evict the newcomer, so surface it and leave the client disconnected.
   */
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

  /**
   * Lazily connect (or reconnect) the active CDP transport.
   * Resets stale session/target state on the host when reconnecting after a
   * drop. If the current client is a disconnected remote transport, the host
   * restores the local transport before the dial.
   */
  async ensureConnected(host: EnsureConnectedHost): Promise<void> {
    // See ensureLocalConnected: don't re-dial a slot we were evicted from.
    if (host.client.superseded === true) {
      this.notifySuperseded();
      return;
    }
    if (host.client.state === 'disconnected') {
      // Before clearing sessions: a backoff tick must not drop live state
      // or open another socket.
      this.throwIfReconnectPaused();
      const dropped = host.client;
      // If we were using a remote transport that got disconnected (follower
      // went away), restore the local transport and clear stale remote state.
      host.restoreLocalAfterRemoteDrop();
      // ONLY the sessions on the transport that dropped: the registry spans
      // several (the local `/cdp` client and a transport per tray runtime).
      host.clearSessionsForTransport(dropped);
      if (host.getClient().state === 'disconnected') {
        // Replay the last-used connect options so the bridge URL + subprotocol survive.
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
    // A successful (re)connect re-arms the supersede notification so a later
    // eviction can surface again.
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
    } catch {
      // A banner failure must not break the agent's CDP path.
    }
  }

  private notifySuperseded(): void {
    if (this.supersededNotified) return;
    this.supersededNotified = true;
    try {
      this.supersededHandler?.();
    } catch {
      // A banner failure must not break the agent's CDP path.
    }
  }
}
