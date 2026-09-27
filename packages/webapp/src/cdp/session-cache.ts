/**
 * Per-tab CDP session registry with LRU eviction and pin protection.
 *
 * Extracted from {@link BrowserAPI} so the LRU / pin / applied-send bookkeeping
 * can be reasoned about (and unit-tested) without the rest of the bridge.
 * Wire detach, transport lifecycle, and the bridge cursor stay on BrowserAPI;
 * this module owns only the maps and the eviction policy.
 */

import type { CDPTransport } from './transport.js';

/**
 * How many per-tab CDP sessions the registry keeps alive at once.
 *
 * Every live session costs Chrome one fan-out of every enabled domain's
 * events over the single `/cdp` socket, so an unbounded registry recreates
 * the leak it replaces (a long session drifts toward the Swift proxy's
 * inbound-queue ceiling). Evicting the least-recently-used entry — and
 * telling Chrome about it with `Target.detachFromTarget` — keeps the fan-out
 * bounded; an evicted tab simply re-attaches on next use.
 */
export const MAX_TAB_SESSIONS = 32;

/**
 * One attached tab. `transport` is the channel the session lives on — the
 * local `/cdp` client, or the per-runtime remote transport for a tray target
 * ("{runtimeId}:{localTargetId}") — so a registry entry stays usable after the
 * bridge's active client swapped to another tab's transport.
 */
export interface TabSession {
  sessionId: string;
  transport: CDPTransport;
  /** Set only for remote (tray) targets; drives remote-transport teardown. */
  remote?: { runtimeId: string; localTargetId: string };
}

/** Called when LRU eviction removes an entry; the host should detach on the wire. */
export type SessionEvictHandler = (targetId: string, entry: TabSession) => void;

export class SessionCache {
  private readonly sessions = new Map<string, TabSession>();
  /**
   * Tabs with work in flight, by pin count — skipped by LRU eviction so a
   * `withTab` body (or a page wait that released the bridge lock) cannot have
   * the session it is using detached underneath it.
   */
  private readonly pinnedTargets = new Map<string, number>();
  /**
   * Successful session-scoped CDP round trips, per session id — the
   * "has this command already changed the page?" signal behind
   * `runOnTab`'s replay gate. Keyed by session rather than kept as one
   * bridge-wide counter so a sibling tab's traffic cannot be mistaken for
   * our own.
   */
  private readonly appliedSends = new Map<string, number>();

  constructor(
    private readonly maxSessions: number = MAX_TAB_SESSIONS,
    private readonly onEvict?: SessionEvictHandler
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  get(targetId: string): TabSession | undefined {
    return this.sessions.get(targetId);
  }

  has(targetId: string): boolean {
    return this.sessions.has(targetId);
  }

  values(): IterableIterator<TabSession> {
    return this.sessions.values();
  }

  entries(): IterableIterator<[string, TabSession]> {
    return this.sessions.entries();
  }

  /** Snapshot of entries — safe to mutate the cache while iterating. */
  snapshot(): Array<[string, TabSession]> {
    return [...this.sessions];
  }

  /**
   * Insert a fresh session and evict the least-recently-used one over the
   * cap. Caller is responsible for transport listeners before calling.
   */
  remember(targetId: string, entry: TabSession): void {
    this.pruneAppliedSends();
    this.sessions.set(targetId, entry);
    this.enforceCap(targetId);
  }

  /**
   * Refresh LRU position by re-inserting. No-op when the entry is not in the
   * registry (caller typically holds the entry it just looked up).
   */
  touch(targetId: string, entry: TabSession): void {
    this.sessions.delete(targetId);
    this.sessions.set(targetId, entry);
  }

  /**
   * Remove and return the entry, or `undefined` when absent. Does not touch
   * the wire — caller decides whether to detach / dispose.
   */
  take(targetId: string): TabSession | undefined {
    const entry = this.sessions.get(targetId);
    if (entry) this.sessions.delete(targetId);
    return entry;
  }

  delete(targetId: string): void {
    this.sessions.delete(targetId);
  }

  clear(): void {
    this.sessions.clear();
  }

  /**
   * Pin a tab's registry entry for the length of an operation, so LRU
   * eviction cannot detach a session that is still being used. Returns the
   * release. Nested pins (a `withTab` body whose navigate also pins) just
   * count.
   */
  pin(targetId: string): () => void {
    this.pinnedTargets.set(targetId, (this.pinnedTargets.get(targetId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.pinnedTargets.get(targetId) ?? 1) - 1;
      if (left > 0) this.pinnedTargets.set(targetId, left);
      else this.pinnedTargets.delete(targetId);
      // An overflow that had nothing evictable is waiting for exactly this.
      this.enforceCap();
    };
  }

  isPinned(targetId: string): boolean {
    return this.pinnedTargets.has(targetId);
  }

  /**
   * Detach least-recently-used sessions until the registry is back under the
   * cap, skipping tabs with work in flight.
   *
   * `protect` is the entry just inserted. Pinned entries are skipped because
   * detaching a tab whose `withTab` body is still running kills the session
   * its session-scoped waits are subscribed to. When every candidate is pinned
   * the cap is exceeded until the next release, which calls back in here.
   */
  enforceCap(protect?: string): void {
    while (this.sessions.size > this.maxSessions) {
      let victim: string | undefined;
      for (const targetId of this.sessions.keys()) {
        if (targetId === protect || this.pinnedTargets.has(targetId)) continue;
        victim = targetId;
        break;
      }
      if (victim === undefined) return; // everything is busy; retry on release
      const evicted = this.sessions.get(victim);
      this.sessions.delete(victim);
      if (evicted) this.onEvict?.(victim, evicted);
    }
  }

  /** Credit one successful session-scoped round trip to the replay guard. */
  noteApplied(sessionId: string): void {
    this.appliedSends.set(sessionId, (this.appliedSends.get(sessionId) ?? 0) + 1);
  }

  appliedCount(sessionId: string): number {
    return this.appliedSends.get(sessionId) ?? 0;
  }

  /**
   * Forget applied-send counters for sessions that left the registry.
   *
   * Deliberately not done on detach: `runOnTab` reads the counter of a
   * session that has just been dropped — that IS the stale case — so an entry
   * has to outlive its session. Sweeping on a size cap keeps the map bounded
   * without racing the reader.
   */
  pruneAppliedSends(): void {
    if (this.appliedSends.size <= this.maxSessions * 4) return;
    const live = new Set([...this.sessions.values()].map((e) => e.sessionId));
    for (const sessionId of [...this.appliedSends.keys()]) {
      if (!live.has(sessionId)) this.appliedSends.delete(sessionId);
    }
  }

  findBySessionId(sessionId: string): [string, TabSession] | undefined {
    for (const [targetId, entry] of this.sessions) {
      if (entry.sessionId === sessionId) return [targetId, entry];
    }
    return undefined;
  }

  /**
   * Entries whose registry key or remote local id matches `targetId`
   * (Chrome's `Target.targetDestroyed` reports the local id).
   */
  findByTargetOrLocalId(targetId: string): Array<[string, TabSession]> {
    const matches: Array<[string, TabSession]> = [];
    for (const [key, entry] of this.sessions) {
      if (key === targetId || entry.remote?.localTargetId === targetId) {
        matches.push([key, entry]);
      }
    }
    return matches;
  }

  anyOnTransport(transport: CDPTransport): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.transport === transport) return true;
    }
    return false;
  }

  anyMatchingRemote(runtimeId: string, localTargetId: string): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.remote?.runtimeId === runtimeId && entry.remote.localTargetId === localTargetId) {
        return true;
      }
    }
    return false;
  }
}
