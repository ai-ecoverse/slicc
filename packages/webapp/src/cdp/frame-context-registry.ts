/**
 * Per-session frameId → executionContextId caches, keyed by execution world.
 *
 * Extracted from {@link BrowserAPI} so the dual-world map can be unit-tested
 * without the Runtime event handlers. Event wiring stays on BrowserAPI; this
 * module owns only the maps and drop/clear accessors.
 */

import type { ExecutionWorld } from './tab-handle.js';

export class FrameContextRegistry {
  /**
   * frameId → executionContextId, keyed by `"<world>:<sessionId>"`.
   *
   * Per SESSION, not per bridge cursor: with commands on different tabs now
   * running concurrently, a sibling tab attaching must not invalidate this
   * tab's contexts — which is exactly what a single bridge-wide cache did.
   */
  private readonly contexts = new Map<string, Map<string, number>>();

  /** Get-or-create the live cache for one session and world. */
  for(sessionId: string, world: ExecutionWorld): Map<string, number> {
    const key = `${world}:${sessionId}`;
    let cache = this.contexts.get(key);
    if (!cache) {
      cache = new Map();
      this.contexts.set(key, cache);
    }
    return cache;
  }

  /** Peek without creating an empty cache entry. */
  peek(sessionId: string, world: ExecutionWorld): Map<string, number> | undefined {
    return this.contexts.get(`${world}:${sessionId}`);
  }

  /** Drop both worlds' context caches for a session that is gone. */
  drop(sessionId: string): void {
    this.contexts.delete(`main:${sessionId}`);
    this.contexts.delete(`isolated:${sessionId}`);
  }

  get size(): number {
    return this.contexts.size;
  }
}
