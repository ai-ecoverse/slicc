import type { CDPTransport } from './transport.js';

export const MAX_TAB_SESSIONS = 32;

export interface TabSession {
  sessionId: string;
  transport: CDPTransport;

  remote?: { runtimeId: string; localTargetId: string };
}

export type SessionEvictHandler = (targetId: string, entry: TabSession) => void;

export class SessionCache {
  private readonly sessions = new Map<string, TabSession>();

  private readonly pinnedTargets = new Map<string, number>();

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

  snapshot(): Array<[string, TabSession]> {
    return [...this.sessions];
  }

  remember(targetId: string, entry: TabSession): void {
    this.pruneAppliedSends();
    this.sessions.set(targetId, entry);
    this.enforceCap(targetId);
  }

  touch(targetId: string, entry: TabSession): void {
    this.sessions.delete(targetId);
    this.sessions.set(targetId, entry);
  }

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

  pin(targetId: string): () => void {
    this.pinnedTargets.set(targetId, (this.pinnedTargets.get(targetId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.pinnedTargets.get(targetId) ?? 1) - 1;
      if (left > 0) this.pinnedTargets.set(targetId, left);
      else this.pinnedTargets.delete(targetId);

      this.enforceCap();
    };
  }

  isPinned(targetId: string): boolean {
    return this.pinnedTargets.has(targetId);
  }

  enforceCap(protect?: string): void {
    while (this.sessions.size > this.maxSessions) {
      let victim: string | undefined;
      for (const targetId of this.sessions.keys()) {
        if (targetId === protect || this.pinnedTargets.has(targetId)) continue;
        victim = targetId;
        break;
      }
      if (victim === undefined) return;
      const evicted = this.sessions.get(victim);
      this.sessions.delete(victim);
      if (evicted) this.onEvict?.(victim, evicted);
    }
  }

  noteApplied(sessionId: string): void {
    this.appliedSends.set(sessionId, (this.appliedSends.get(sessionId) ?? 0) + 1);
  }

  appliedCount(sessionId: string): number {
    return this.appliedSends.get(sessionId) ?? 0;
  }

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
