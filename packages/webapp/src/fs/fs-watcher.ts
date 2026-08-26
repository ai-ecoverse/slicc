import { createLogger } from '../base/logger.js';
import type { FsChangeEvent } from './types.js';

const log = createLogger('fs-watcher');

// Defined in `types.ts` (see the note there) and re-exported here, where
// every existing consumer already imports them from.
export type { FsChangeEvent, FsChangeType } from './types.js';

export type FsWatchFilter = (path: string) => boolean;
export type FsWatchCallback = (events: FsChangeEvent[]) => void;

interface WatchRegistration {
  id: string;
  basePath: string;
  filter: FsWatchFilter;
  callback: FsWatchCallback;
}

let nextId = 0;

function isWithinBasePath(path: string, basePath: string): boolean {
  return basePath === '/' || path === basePath || path.startsWith(basePath + '/');
}

export class FsWatcher {
  private registrations = new Map<string, WatchRegistration>();

  /**
   * Register a watcher for changes under basePath that pass the filter.
   * Returns an unsubscribe function.
   */
  watch(basePath: string, filter: FsWatchFilter, callback: FsWatchCallback): () => void {
    const id = `fsw-${++nextId}`;
    this.registrations.set(id, { id, basePath, filter, callback });
    log.debug('Watch registered', { id, basePath });
    return () => {
      this.registrations.delete(id);
      log.debug('Watch unregistered', { id });
    };
  }

  /**
   * Called by VirtualFS after mutating operations.
   * Routes events to matching watchers (basePath prefix match + filter).
   */
  notify(events: FsChangeEvent[]): void {
    if (events.length === 0) return;
    for (const [, reg] of this.registrations) {
      const matched = events.filter(
        (e) => isWithinBasePath(e.path, reg.basePath) && reg.filter(e.path)
      );
      if (matched.length > 0) {
        try {
          reg.callback(matched);
        } catch (err) {
          log.error('Watch callback error', {
            id: reg.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /** Remove all watchers. */
  dispose(): void {
    this.registrations.clear();
    log.debug('All watchers disposed');
  }

  /** Number of active watchers (for testing/debugging). */
  get size(): number {
    return this.registrations.size;
  }
}
