/**
 * CDPTransport — abstract interface for sending CDP commands.
 *
 * Implemented by CDPClient (WebSocket, CLI mode) and DebuggerClient
 * (chrome.debugger API, extension mode).
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
}
