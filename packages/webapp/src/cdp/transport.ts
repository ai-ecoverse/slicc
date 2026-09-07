/**
 * CDPTransport — abstract interface for sending CDP commands.
 *
 * Implemented by `CDPClient` (WebSocket, CLI mode), `ExtensionBridgeTransport`
 * (thin extension's `chrome.runtime` Port to the service worker's
 * `chrome.debugger` proxy), `CherryHostTransport` (synthetic CDP over
 * postMessage in cherry follower mode), and `PanelRpcCdpTransport`
 * (federated tray targets driven from the kernel worker).
 */

import type { CDPPayload } from '@slicc/shared-ts';

import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';

/**
 * Listener for {@link CDPTransport.onStateChange}. `reason` is a
 * human-readable description of why the transport left its previous state
 * (a close reason, a supersede); it is diagnostic only.
 */
export type CDPStateListener = (state: ConnectionState, reason?: string) => void;

export interface CDPTransport {
  /** Connect to the CDP endpoint. Options may be ignored by some transports. */
  connect(options?: CDPConnectOptions): Promise<void>;

  /** Disconnect and clean up. */
  disconnect(): void;

  /** Send a CDP command and wait for the response. */
  send(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout?: number
  ): Promise<CDPPayload>;

  /** Subscribe to a CDP event. */
  on(event: string, listener: CDPEventListener): void;

  /** Unsubscribe from a CDP event. */
  off(event: string, listener: CDPEventListener): void;

  /** Wait for a specific CDP event to fire once. */
  once(event: string, timeout?: number): Promise<CDPPayload>;

  /** Current connection state. */
  readonly state: ConnectionState;

  /**
   * Optional: observe connection-state transitions. Returns an unsubscribe
   * function. Only transports whose connection can drop underneath their
   * owner implement it — today `CDPClient`, whose WebSocket the standalone
   * `/cdp` proxy can close at any time.
   *
   * Polling `state` is not enough across a process hop: the kernel worker
   * drives CDP through `WorkerCdpProxy`, whose `state` says nothing about the
   * page-side client. `startPageCdpForwarder` subscribes here and relays the
   * transition as a `cdp-reset` / `cdp-ready` wire message so the worker-side
   * `BrowserAPI` can drop its stale session and re-attach instead of sending
   * commands into a dead session for the rest of the run.
   */
  onStateChange?(listener: CDPStateListener): () => void;

  /**
   * True when this transport's last close was the standalone CDP proxy
   * evicting it because a newer client took the single proxy slot (see
   * `CDP_SUPERSEDED_CLOSE_CODE`). Only `CDPClient` (the WebSocket transport)
   * tracks this; other transports leave it `undefined`. `BrowserAPI` reads it
   * to stop auto-reconnecting an evicted local client.
   */
  readonly superseded?: boolean;

  /**
   * True when this transport is the thin extension's `chrome.runtime` Port
   * to the service worker's `chrome.debugger` proxy (`ExtensionBridgeTransport`).
   * Only that transport sets it; all others leave it `undefined`.
   *
   * The kernel host reads it to SKIP the CDP-level `NavigationWatcher`: the
   * bridge shims only a handful of session-scoped `Target.*` commands and
   * rejects sessionless browser-level ones like `Target.setDiscoverTargets`,
   * so the watcher would tear down on start anyway. In the thin extension the
   * service worker already observes main-frame `Link` headers via
   * `chrome.webRequest` and emits `navigate-lick` messages, so a CDP watcher
   * is both non-functional over this transport and redundant.
   */
  readonly isExtensionBridge?: boolean;
}
