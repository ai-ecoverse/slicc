import { handleFsRequest } from '../tray-fs-handler.js';
import type { TrayFsRequest, TrayFsResponse } from '../tray-sync-protocol.js';
import type { FollowerSyncContext } from './context.js';

interface FsResolver {
  resolve: (responses: TrayFsResponse[]) => void;
  reject: (err: Error) => void;
  responses: TrayFsResponse[];
}

export class FollowerFsBridge {
  private readonly fsResolvers = new Map<string, FsResolver>();

  constructor(private readonly context: FollowerSyncContext) {}

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
