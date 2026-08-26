/**
 * PreviewBridgeCdpTransport — leader-side CDP transport that drives a bridged
 * preview tab by relaying CDP over the controller WebSocket (keyed by connId).
 *
 * Extends SyntheticCdpTransport to synthesize the session lifecycle locally,
 * and forwards real CDP methods via LeaderToWorkerControlMessage
 * bridge.cdp.request messages.
 */

import type {
  CDPPayload,
  LeaderToWorkerControlMessage,
  WorkerBridgeCdpResponse,
} from '@slicc/shared-ts';
import { PendingRequestTable } from './pending-request-table.js';
import type { SyntheticCdpTransportOptions } from './synthetic-cdp-transport.js';
import { SyntheticCdpTransport } from './synthetic-cdp-transport.js';
import type { CDPConnectOptions } from './types.js';

const DEFAULT_TIMEOUT = 30000;

const PREVIEW_SYNTHETIC_IDS = {
  target: 'preview-target',
  session: 'preview-session',
  frame: 'preview-frame',
  loader: 'preview-loader',
};

export interface PreviewBridgeCdpTransportOptions extends SyntheticCdpTransportOptions {
  /** The preview bridge connection ID. */
  connId: string;
  /** Send function to post messages to the worker over the controller WS. */
  send: (msg: LeaderToWorkerControlMessage) => void;
}

export class PreviewBridgeCdpTransport extends SyntheticCdpTransport {
  private readonly connId: string;
  private readonly sendToWorker: (msg: LeaderToWorkerControlMessage) => void;
  private nextId = 1;
  private pending = new PendingRequestTable<number>();

  constructor(opts: PreviewBridgeCdpTransportOptions) {
    super({
      targetUrl: opts.targetUrl,
      targetOrigin: opts.targetOrigin,
      title: opts.title,
      ids: opts.ids ?? PREVIEW_SYNTHETIC_IDS,
    });
    this.connId = opts.connId;
    this.sendToWorker = opts.send;
  }

  async connect(_options?: CDPConnectOptions): Promise<void> {
    this._state = 'connected';
  }

  /**
   * A `Target.closeTarget` on a preview target really closes the visitor's bridge
   * connection. The worker closes that socket and echoes `bridge.disconnected`,
   * which removes this transport from `LeaderSyncManager.bridgeConns` — so closing
   * a preview tab is no longer a silent no-op.
   */
  protected override onCloseTarget(): void {
    this.sendToWorker({ type: 'bridge.close', connId: this.connId });
  }

  disconnect(): void {
    this.pending.rejectAll('PreviewBridgeCdpTransport disconnected');
    this._state = 'disconnected';
  }

  /**
   * Forward non-synthetic CDP methods to the preview bridge via the controller WS.
   */
  protected async forward(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout = DEFAULT_TIMEOUT
  ): Promise<CDPPayload> {
    const id = this.nextId++;

    const response = this.pending.issue(
      id,
      timeout,
      `PreviewBridge CDP timed out after ${timeout}ms: ${method}`
    );

    // Post bridge.cdp.request to worker
    this.sendToWorker({
      type: 'bridge.cdp.request',
      connId: this.connId,
      id,
      method,
      params,
      sessionId,
    });

    return response;
  }

  /**
   * Deliver a CDP response from the worker. Resolves the pending call with
   * the UNWRAPPED result (payload.result ?? {}), matching CherryHostTransport
   * and the shape BrowserAPI expects.
   */
  deliverResponse(id: number, payload: Pick<WorkerBridgeCdpResponse, 'result' | 'error'>): void {
    if (payload.error) {
      this.pending.reject(
        id,
        new Error(`PreviewBridge CDP error: ${payload.error.message} (${payload.error.code})`)
      );
    } else {
      // Unwrap the result (NOT {result: ...})
      this.pending.resolve(id, payload.result ?? {});
    }
  }
}
