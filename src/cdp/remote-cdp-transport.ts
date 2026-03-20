/**
 * RemoteCDPTransport — routes CDP commands over the tray data channel
 * to a remote runtime that owns the target browser tab.
 */

import type { CDPTransport } from './transport.js';
import type { CDPEventListener, ConnectionState } from './types.js';
import { reassembleCDPResponse } from '../scoops/tray-sync-protocol.js';

/**
 * Interface for sending CDP requests over the data channel.
 * Implemented by FollowerSyncManager and LeaderSyncManager.
 */
export interface RemoteCDPSender {
  sendCDPRequest(
    requestId: string,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): void;
}

export class RemoteCDPTransport implements CDPTransport {
  private readonly pending = new Map<
    string,
    {
      resolve: (r: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error('Transport disconnected'));
    }
    this.pending.clear();
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout?: number
  ): Promise<Record<string, unknown>> {
    if (this._state === 'disconnected') {
      throw new Error('Transport disconnected');
    }
    const requestId = `remote-${++this.requestCounter}-${Date.now()}`;
    const tm = timeout ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Remote CDP request timed out after ${tm}ms: ${method}`));
      }, tm);
      this.pending.set(requestId, { resolve, reject, timer });
      this.sender.sendCDPRequest(requestId, method, params, sessionId);
    });
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

  once(event: string, timeout?: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const tm = timeout ?? this.timeoutMs;
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Remote CDP event timed out: ${event}`));
      }, tm);
      const handler = (params: Record<string, unknown>) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };
      this.on(event, handler);
    });
  }

  /** Called by the sync manager when a cdp.response arrives for this transport. */
  handleResponse(
    requestId: string,
    result?: Record<string, unknown>,
    error?: string,
    chunkData?: string,
    chunkIndex?: number,
    totalChunks?: number
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

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

    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (assembled.error) entry.reject(new Error(assembled.error));
    else entry.resolve(assembled.result ?? {});
  }

  /** Called by the sync manager when a CDP event arrives for this transport. */
  handleEvent(method: string, params: Record<string, unknown>): void {
    const listeners = this.eventListeners.get(method);
    if (listeners) {
      for (const cb of listeners) cb(params);
    }
  }
}
