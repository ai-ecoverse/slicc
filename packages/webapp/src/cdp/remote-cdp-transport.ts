/**
 * RemoteCDPTransport — routes CDP commands over the tray data channel
 * to a remote runtime that owns the target browser tab.
 */

import { type CDPPayload, reassembleCDPResponse } from '@slicc/shared-ts';
import { PendingRequestTable, waitForEvent } from './pending-request-table.js';
import type { CDPTransport } from './transport.js';
import type { CDPEventListener, ConnectionState } from './types.js';

/**
 * Interface for sending CDP requests over the data channel.
 * Implemented by FollowerSyncManager and LeaderSyncManager.
 */
export interface RemoteCDPSender {
  sendCDPRequest(requestId: string, method: string, params?: CDPPayload, sessionId?: string): void;
}

export class RemoteCDPTransport implements CDPTransport {
  private readonly pending = new PendingRequestTable<string>();
  private readonly eventListeners = new Map<string, Set<CDPEventListener>>();
  private readonly chunkBuffers = new Map<
    string,
    { chunks: string[]; received: number; totalChunks: number }
  >();
  private _state: ConnectionState = 'connected';
  private requestCounter = 0;

  constructor(
    private readonly sender: RemoteCDPSender,
    private readonly timeoutMs = 30000
  ) {}

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    /* no-op — connected via data channel */
  }

  disconnect(): void {
    this._state = 'disconnected';
    this.pending.rejectAll('Transport disconnected');
  }

  async send(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout?: number
  ): Promise<CDPPayload> {
    if (this._state === 'disconnected') {
      throw new Error('Transport disconnected');
    }
    const requestId = `remote-${++this.requestCounter}-${Date.now()}`;
    const tm = timeout ?? this.timeoutMs;
    const response = this.pending.issue(
      requestId,
      tm,
      `Remote CDP request timed out after ${tm}ms: ${method}`
    );
    this.sender.sendCDPRequest(requestId, method, params, sessionId);
    return response;
  }

  on(event: string, listener: CDPEventListener): void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: CDPEventListener): void {
    this.eventListeners.get(event)?.delete(listener);
  }

  once(event: string, timeout?: number): Promise<CDPPayload> {
    return waitForEvent<CDPPayload>(
      (handler) => {
        this.on(event, handler);
        return () => this.off(event, handler);
      },
      timeout ?? this.timeoutMs,
      `Remote CDP event timed out: ${event}`
    );
  }

  /** Called by the sync manager when a cdp.response arrives for this transport. */
  handleResponse(
    requestId: string,
    result?: CDPPayload,
    error?: string,
    chunkData?: string,
    chunkIndex?: number,
    totalChunks?: number
  ): void {
    if (!this.pending.has(requestId)) return;

    // Use reassembleCDPResponse for both chunked and non-chunked messages
    const assembled = reassembleCDPResponse(this.chunkBuffers, {
      type: 'cdp.response',
      requestId,
      result,
      error,
      chunkData,
      chunkIndex,
      totalChunks,
    });

    if (!assembled) return; // Still waiting for more chunks

    if (assembled.error) this.pending.reject(requestId, new Error(assembled.error));
    else this.pending.resolve(requestId, assembled.result ?? {});
  }

  /** Called by the sync manager when a CDP event arrives for this transport. */
  handleEvent(method: string, params: CDPPayload): void {
    const listeners = this.eventListeners.get(method);
    if (listeners) {
      for (const cb of listeners) cb(params);
    }
  }
}
