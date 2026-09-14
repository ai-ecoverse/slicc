import type { LeaderToFollowerMessage, SprinkleSummary } from '../tray-sync-protocol.js';
import type { FollowerSyncContext } from './context.js';

const DEFAULT_SPRINKLE_FETCH_TIMEOUT_MS = 15000;

interface SprinkleFetchBuffer {
  sprinkleName: string;
  chunks: Map<number, string>;
  totalChunks: number;
}

interface SprinkleWaiter {
  readonly id: symbol;
  resolve: (content: string) => void;
  reject: (err: Error) => void;
}

export class FollowerSprinkleCache {
  private latestSprinkles: SprinkleSummary[] = [];
  private readonly sprinkleContentCache = new Map<string, string>();
  private readonly pendingSprinkleFetches = new Map<string, SprinkleFetchBuffer>();
  private readonly inflightSprinkleByName = new Map<string, string>();

  private readonly sprinkleContentWaiters = new Map<string, SprinkleWaiter[]>();

  private cacheEpoch = 0;

  private readonly fetchEpoch = new Map<string, number>();

  constructor(private readonly context: FollowerSyncContext) {}

  getSprinkles(): SprinkleSummary[] {
    return this.latestSprinkles;
  }

  fetchSprinkleContent(sprinkleName: string): Promise<string> {
    const cached = this.sprinkleContentCache.get(sprinkleName);
    if (cached !== undefined) return Promise.resolve(cached);

    const timeoutMs =
      this.context.options.sprinkleFetchTimeoutMs ?? DEFAULT_SPRINKLE_FETCH_TIMEOUT_MS;

    return new Promise<string>((resolve, reject) => {
      const waiterId = Symbol('sprinkle-waiter');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wrapResolve = (content: string) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(content);
      };
      const wrapReject = (err: Error) => {
        if (timer !== undefined) clearTimeout(timer);
        reject(err);
      };

      const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
      waiters.push({ id: waiterId, resolve: wrapResolve, reject: wrapReject });
      this.sprinkleContentWaiters.set(sprinkleName, waiters);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const list = this.sprinkleContentWaiters.get(sprinkleName);
          if (list) {
            const idx = list.findIndex((w) => w.id === waiterId);
            if (idx >= 0) list.splice(idx, 1);
            if (list.length === 0) {
              this.sprinkleContentWaiters.delete(sprinkleName);
              this.cancelSprinkleFetch(
                sprinkleName,
                `Sprinkle fetch for "${sprinkleName}" timed out after ${timeoutMs}ms`
              );
            }
          }
          reject(new Error(`Sprinkle fetch for "${sprinkleName}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      if (this.inflightSprinkleByName.has(sprinkleName)) return;

      const requestId = `sprinkle-fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.inflightSprinkleByName.set(sprinkleName, requestId);
      this.pendingSprinkleFetches.set(requestId, {
        sprinkleName,
        chunks: new Map(),
        totalChunks: 1,
      });
      this.fetchEpoch.set(requestId, this.cacheEpoch);
      this.context.send({ type: 'sprinkle.fetch', requestId, sprinkleName });
    });
  }

  clearSprinkleCache(sprinkleName?: string): void {
    if (sprinkleName === undefined) this.sprinkleContentCache.clear();
    else this.sprinkleContentCache.delete(sprinkleName);
  }

  cancelSprinkleFetch(sprinkleName: string, reason = 'fetch cancelled'): void {
    const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
    this.sprinkleContentWaiters.delete(sprinkleName);
    const requestId = this.inflightSprinkleByName.get(sprinkleName);
    if (requestId !== undefined) {
      this.inflightSprinkleByName.delete(sprinkleName);
      this.pendingSprinkleFetches.delete(requestId);
      this.fetchEpoch.delete(requestId);
    }
    if (waiters.length === 0) return;
    const err = new Error(reason);
    for (const waiter of waiters) waiter.reject(err);
  }

  handleList(sprinkles: SprinkleSummary[]): void {
    this.context.log.info('Sprinkles list received from leader', {
      sprinkleCount: sprinkles.length,
    });
    this.sprinkleContentCache.clear();
    this.cacheEpoch++;
    this.latestSprinkles = sprinkles;
    this.context.options.onSprinklesList?.(sprinkles);
  }

  handleReloaded(sprinkleName: string): void {
    this.sprinkleContentCache.delete(sprinkleName);
    this.context.options.onSprinkleReloaded?.(sprinkleName);
  }

  handleContent(message: LeaderToFollowerMessage & { type: 'sprinkle.content' }): void {
    const { requestId, sprinkleName, content, chunkIndex, totalChunks, error } = message;

    if (error) {
      this.context.log.warn('sprinkle.content error from leader', { sprinkleName, error });
      this.pendingSprinkleFetches.delete(requestId);
      this.inflightSprinkleByName.delete(sprinkleName);
      this.fetchEpoch.delete(requestId);
      const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
      this.sprinkleContentWaiters.delete(sprinkleName);
      for (const waiter of waiters) waiter.reject(new Error(error));
      return;
    }

    if (!this.pendingSprinkleFetches.has(requestId)) {
      this.context.log.debug('Dropping sprinkle.content for unknown requestId', {
        sprinkleName,
        requestId,
      });
      return;
    }

    const assembled = this.assembleContent(
      requestId,
      sprinkleName,
      content,
      chunkIndex,
      totalChunks
    );
    if (assembled === null) return;

    const fetchedEpoch = this.fetchEpoch.get(requestId);
    this.fetchEpoch.delete(requestId);
    if (fetchedEpoch === this.cacheEpoch) {
      this.sprinkleContentCache.set(sprinkleName, assembled);
    }
    this.inflightSprinkleByName.delete(sprinkleName);
    const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
    this.sprinkleContentWaiters.delete(sprinkleName);
    for (const waiter of waiters) waiter.resolve(assembled);
  }

  private assembleContent(
    requestId: string,
    sprinkleName: string,
    content: string,
    chunkIndex: number | undefined,
    totalChunks: number | undefined
  ): string | null {
    if (chunkIndex === undefined || totalChunks === undefined) {
      this.pendingSprinkleFetches.delete(requestId);
      return content;
    }
    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      this.context.log.warn('Dropping sprinkle.content with out-of-range chunkIndex', {
        sprinkleName,
        chunkIndex,
        totalChunks,
      });
      return null;
    }
    const buffer = this.pendingSprinkleFetches.get(requestId)!;
    buffer.totalChunks = totalChunks;
    if (!buffer.chunks.has(chunkIndex)) {
      buffer.chunks.set(chunkIndex, content);
    } else {
      this.context.log.warn('Dropping duplicate sprinkle.content chunk', {
        sprinkleName,
        chunkIndex,
      });
    }
    if (buffer.chunks.size < totalChunks) return null;
    const ordered: string[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = buffer.chunks.get(i);
      if (chunk === undefined) {
        this.context.log.warn('Chunked sprinkle.content missing chunk after assembly', {
          sprinkleName,
          missingIndex: i,
        });
        return null;
      }
      ordered.push(chunk);
    }
    this.pendingSprinkleFetches.delete(requestId);
    return ordered.join('');
  }

  rejectPending(reason: string): void {
    const err = new Error(reason);
    for (const [, waiters] of this.sprinkleContentWaiters) {
      for (const waiter of waiters) waiter.reject(err);
    }
    this.sprinkleContentWaiters.clear();
    this.pendingSprinkleFetches.clear();
    this.inflightSprinkleByName.clear();
    this.fetchEpoch.clear();
  }
}
