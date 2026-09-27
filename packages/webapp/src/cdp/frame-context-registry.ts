import type { ExecutionWorld } from './tab-handle.js';

export class FrameContextRegistry {
  private readonly contexts = new Map<string, Map<string, number>>();

  for(sessionId: string, world: ExecutionWorld): Map<string, number> {
    const key = `${world}:${sessionId}`;
    let cache = this.contexts.get(key);
    if (!cache) {
      cache = new Map();
      this.contexts.set(key, cache);
    }
    return cache;
  }

  peek(sessionId: string, world: ExecutionWorld): Map<string, number> | undefined {
    return this.contexts.get(`${world}:${sessionId}`);
  }

  drop(sessionId: string): void {
    this.contexts.delete(`main:${sessionId}`);
    this.contexts.delete(`isolated:${sessionId}`);
  }

  get size(): number {
    return this.contexts.size;
  }
}
