import type { RemoteTargetInfo, TrayTargetEntry } from './tray-sync-protocol.js';

/**
 * Maintains a merged view of browser targets from multiple runtimes in a tray.
 *
 * The leader calls `setTargets()` when a follower (or itself) advertises its
 * targets, and `getEntries()` to build the `targets.registry` broadcast.
 */
export class TrayTargetRegistry {
  private readonly runtimes = new Map<string, RemoteTargetInfo[]>();
  private dirty = false;

  /** Replace all targets for a given runtime (idempotent). */
  setTargets(runtimeId: string, targets: RemoteTargetInfo[]): void {
    this.runtimes.set(runtimeId, targets);
    this.dirty = true;
  }

  /** Remove all targets for a runtime (e.g. on disconnect). */
  removeRuntime(runtimeId: string): void {
    if (this.runtimes.delete(runtimeId)) {
      this.dirty = true;
    }
  }

  /**
   * Get the merged view of all targets.
   *
   * `isLocal` is always `false` — the consumer sets it based on their own
   * runtimeId when presenting to the UI.
   */
  getEntries(): TrayTargetEntry[] {
    this.dirty = false;
    const entries: TrayTargetEntry[] = [];
    for (const [runtimeId, targets] of this.runtimes) {
      for (const t of targets) {
        entries.push({
          targetId: `${runtimeId}:${t.targetId}`,
          localTargetId: t.targetId,
          runtimeId,
          title: t.title,
          url: t.url,
          isLocal: false,
        });
      }
    }
    return entries;
  }

  /** True if `setTargets` or `removeRuntime` was called since last `getEntries()`. */
  hasChanged(): boolean {
    return this.dirty;
  }

  /** Get the set of known runtime IDs. */
  getRuntimeIds(): string[] {
    return [...this.runtimes.keys()];
  }
}
