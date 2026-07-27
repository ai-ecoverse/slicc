import { handleFsRequest } from '../tray-fs-handler.js';
import type { TrayFsRequest, TrayFsResponse } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

/** Tracks an fs request being routed through the leader. */
export interface PendingFsRoute {
  /** bootstrapId of the follower that originated the request (or '__leader__') */
  requesterBootstrapId: string;
  /** bootstrapId of the follower executing the request. */
  targetBootstrapId: string;
  /** The original requestId from the requester. */
  requestId: string;
  /** Accumulated chunked responses (for multi-chunk file reads). */
  chunks: TrayFsResponse[];
  /** Expected total chunks (set from first response). */
  totalChunks: number;
}

interface FsResolver {
  resolve: (responses: TrayFsResponse[]) => void;
  reject: (err: Error) => void;
  responses: TrayFsResponse[];
}

export class FsRouter {
  /** Maps requestId to routing info for fs requests in flight through the leader. */
  private readonly pendingFsRoutes = new Map<string, PendingFsRoute>();
  /** Resolvers for leader-originated fs requests. */
  private readonly fsResolvers = new Map<string, FsResolver>();

  constructor(private readonly context: LeaderSyncContext) {
    context.followers.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) => this.rejectPendingForFollower(bootstrapId),
    });
  }

  /** Execute an fs request on the leader's own VFS. */
  async executeLocalFs(
    requestId: string,
    request: TrayFsRequest,
    requesterBootstrapId: string
  ): Promise<void> {
    const follower = this.context.followers.followers.get(requesterBootstrapId);
    if (!follower) return;

    const vfs = this.context.options.vfs;
    if (!vfs) {
      follower.sync.send({
        type: 'fs.response',
        requestId,
        response: { ok: false, error: 'Leader has no VFS' },
      });
      return;
    }

    const responses = await handleFsRequest(vfs, request);
    for (const response of responses) {
      follower.sync.send({ type: 'fs.response', requestId, response });
    }
  }

  /** Forward an fs request to the follower that owns the target runtime. */
  forwardFsRequest(
    requestId: string,
    targetRuntimeId: string,
    request: TrayFsRequest,
    requesterBootstrapId: string
  ): void {
    const targetBootstrapId = this.context.followers.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId
      ? this.context.followers.followers.get(targetBootstrapId)
      : undefined;
    const requester = this.context.followers.followers.get(requesterBootstrapId);

    if (!targetBootstrapId || !targetFollower) {
      requester?.sync.send({
        type: 'fs.response',
        requestId,
        response: { ok: false, error: `Target runtime "${targetRuntimeId}" not connected` },
      });
      return;
    }

    this.pendingFsRoutes.set(requestId, {
      requesterBootstrapId,
      targetBootstrapId,
      requestId,
      chunks: [],
      totalChunks: 1,
    });
    targetFollower.sync.send({ type: 'fs.request', requestId, request });
  }

  /** Reassemble and route an fs response from a follower. */
  handleFsResponse(requestId: string, response: TrayFsResponse): void {
    const route = this.pendingFsRoutes.get(requestId);
    if (!route) {
      this.resolveUnroutedLeaderResponse(requestId, response);
      return;
    }

    if (route.requesterBootstrapId !== '__leader__') {
      this.context.followers.followers
        .get(route.requesterBootstrapId)
        ?.sync.send({ type: 'fs.response', requestId, response });
    }

    const responses = this.addResponseChunk(route, response);
    if (!responses) return;
    this.pendingFsRoutes.delete(requestId);

    if (route.requesterBootstrapId === '__leader__') {
      const resolver = this.fsResolvers.get(requestId);
      if (resolver) {
        this.fsResolvers.delete(requestId);
        resolver.resolve(responses);
      }
    }
  }

  /** Send an fs request to a remote runtime from the leader's own code. */
  sendFsRequest(targetRuntimeId: string, request: TrayFsRequest): Promise<TrayFsResponse[]> {
    if (targetRuntimeId === 'leader') {
      const vfs = this.context.options.vfs;
      if (!vfs) return Promise.resolve([{ ok: false, error: 'Leader has no VFS' }]);
      return handleFsRequest(vfs, request);
    }

    const targetBootstrapId = this.context.followers.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId
      ? this.context.followers.followers.get(targetBootstrapId)
      : undefined;
    if (!targetBootstrapId || !targetFollower) {
      return Promise.resolve([
        { ok: false, error: `Target runtime "${targetRuntimeId}" not connected` },
      ]);
    }

    const requestId = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<TrayFsResponse[]>((resolve, reject) => {
      this.fsResolvers.set(requestId, { resolve, reject, responses: [] });
      this.pendingFsRoutes.set(requestId, {
        requesterBootstrapId: '__leader__',
        targetBootstrapId,
        requestId,
        chunks: [],
        totalChunks: 1,
      });
      targetFollower.sync.send({ type: 'fs.request', requestId, request });
    });
  }

  private addResponseChunk(
    route: PendingFsRoute,
    response: TrayFsResponse
  ): TrayFsResponse[] | null {
    if (route.chunks.length === 0) {
      route.totalChunks = (response.ok && response.totalChunks) || 1;
    }
    route.chunks.push(response);
    if (route.chunks.length < route.totalChunks) return null;
    return route.chunks;
  }

  private resolveUnroutedLeaderResponse(requestId: string, response: TrayFsResponse): void {
    const resolver = this.fsResolvers.get(requestId);
    if (!resolver) return;
    resolver.responses.push(response);
    const totalChunks = (response.ok && response.totalChunks) || 1;
    if (resolver.responses.length >= totalChunks) {
      this.fsResolvers.delete(requestId);
      resolver.resolve(resolver.responses);
    }
  }

  private rejectPendingForFollower(bootstrapId: string): void {
    for (const [requestId, route] of this.pendingFsRoutes) {
      if (route.targetBootstrapId !== bootstrapId && route.requesterBootstrapId !== bootstrapId) {
        continue;
      }
      this.pendingFsRoutes.delete(requestId);
      const resolver = this.fsResolvers.get(requestId);
      if (!resolver) continue;
      this.fsResolvers.delete(requestId);
      resolver.reject(new Error('follower disconnected before the fs request completed'));
    }
  }
}
