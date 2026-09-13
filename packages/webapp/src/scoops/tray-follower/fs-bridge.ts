import { handleFsRequest } from '../tray-fs-handler.js';
import type { TrayFsRequest, TrayFsResponse } from '../tray-sync-protocol.js';
import type { FollowerSyncContext } from './context.js';

interface FsResolver {
  resolve: (responses: TrayFsResponse[]) => void;
  reject: (err: Error) => void;
  responses: TrayFsResponse[];
}

/** Follower-side fs request/response routing over the tray sync channel. */
export class FollowerFsBridge {
  private readonly fsResolvers = new Map<string, FsResolver>();

  constructor(private readonly context: FollowerSyncContext) {}

  /**
   * Execute an fs request on the follower's local VFS.
   * Sends the response(s) back to the leader.
   */
  async executeLocalFs(requestId: string, request: TrayFsRequest): Promise<void> {
    const vfs = this.context.options.vfs;
    if (!vfs) {
      this.context.send({
        type: 'fs.response',
        requestId,
        response: { ok: false, error: 'Follower has no VFS' },
      });
      return;
    }

    // Mirror executeLocalCDP / executeLocalTabOpen: any rejection from
    // `handleFsRequest` becomes an `fs.response` with `ok: false` instead of
    // an unhandled async rejection — otherwise the leader's `fsResolvers`
    // entry would never resolve, hanging any caller awaiting the response.
    let responses;
    try {
      responses = await handleFsRequest(vfs, request);
    } catch (err) {
      this.context.send({
        type: 'fs.response',
        requestId,
        response: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    for (const response of responses) {
      this.context.send({ type: 'fs.response', requestId, response });
    }
  }

  /**
   * Route an fs response from the leader to the appropriate pending resolver.
   * Handles chunked responses by accumulating until all chunks arrive.
   */
  routeFsResponse(requestId: string, response: TrayFsResponse): void {
    const resolver = this.fsResolvers.get(requestId);
    if (!resolver) return;

    resolver.responses.push(response);
    const totalChunks = (response.ok && response.totalChunks) || 1;
    if (resolver.responses.length >= totalChunks) {
      this.fsResolvers.delete(requestId);
      resolver.resolve(resolver.responses);
    }
  }

  /**
   * Send an fs request to a remote runtime via the leader.
   * Returns a promise that resolves with the response(s).
   */
  sendFsRequest(targetRuntimeId: string, request: TrayFsRequest): Promise<TrayFsResponse[]> {
    const requestId = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<TrayFsResponse[]>((resolve, reject) => {
      this.fsResolvers.set(requestId, { resolve, reject, responses: [] });
      this.context.send({ type: 'fs.request', requestId, targetRuntimeId, request });
    });
  }

  rejectPending(reason: string): void {
    const err = new Error(reason);
    for (const { reject } of this.fsResolvers.values()) reject(err);
    this.fsResolvers.clear();
  }
}
