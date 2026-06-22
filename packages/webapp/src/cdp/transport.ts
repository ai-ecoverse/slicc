/**
 * CDPTransport — abstract interface for sending CDP commands.
 *
 * Implemented by `CDPClient` (WebSocket, CLI mode), `ExtensionBridgeTransport`
 * (thin extension's `chrome.runtime` Port to the service worker's
 * `chrome.debugger` proxy), `CherryHostTransport` (synthetic CDP over
 * postMessage in cherry follower mode), and `PanelRpcCdpTransport`
 * (federated tray targets driven from the kernel worker).
 */

import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';

export interface CDPTransport {
  /** Connect to the CDP endpoint. Options may be ignored by some transports. */
  connect(options?: CDPConnectOptions): Promise<void>;

  /** Disconnect and clean up. */
  disconnect(): void;

  /** Send a CDP command and wait for the response. */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout?: number
  ): Promise<Record<string, unknown>>;

  /** Subscribe to a CDP event. */
  on(event: string, listener: CDPEventListener): void;

  /** Unsubscribe from a CDP event. */
  off(event: string, listener: CDPEventListener): void;

  /** Wait for a specific CDP event to fire once. */
  once(event: string, timeout?: number): Promise<Record<string, unknown>>;

  /** Current connection state. */
  readonly state: ConnectionState;

  /**
   * True when this transport's last close was the standalone CDP proxy
   * evicting it because a newer client took the single proxy slot (see
   * `CDP_SUPERSEDED_CLOSE_CODE`). Only `CDPClient` (the WebSocket transport)
   * tracks this; other transports leave it `undefined`. `BrowserAPI` reads it
   * to stop auto-reconnecting an evicted local client.
   */
  readonly superseded?: boolean;
}
