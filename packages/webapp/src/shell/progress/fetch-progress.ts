import type { FetchProgressObserver } from '../proxied-fetch.js';
import type { ProgressEmitter } from './emitter.js';

interface InFlight {
  id: string;
  label: string;
  startedAt: number;
}

export function fetchLabel(url: string): string {
  try {
    const u = new URL(url);
    return `↓ ${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return `↓ ${url}`;
  }
}

export function createFetchProgressObserver(
  emitter: ProgressEmitter,
  now: () => number = Date.now
): FetchProgressObserver {
  const inflight = new Map<string, InFlight[]>();

  const current = (url: string): InFlight | undefined => inflight.get(url)?.[0];

  return {
    start(url, total) {
      if (!emitter.hasSink()) return;
      const entry: InFlight = {
        id: emitter.allocateId('net'),
        label: fetchLabel(url),
        startedAt: now(),
      };
      const stack = inflight.get(url);
      if (stack) stack.push(entry);
      else inflight.set(url, [entry]);
      emitter.emit({
        id: entry.id,
        label: entry.label,
        fraction: total === undefined ? undefined : 0,
        done: 0,
        total,
        unit: 'bytes',
        phase: 'start',
      });
    },
    chunk(url, loaded, total) {
      const entry = current(url);
      if (!entry) return;
      let fraction: number | undefined;
      let etaMs: number | undefined;
      if (total !== undefined && total > 0) {
        fraction = Math.min(1, loaded / total);
        const elapsed = now() - entry.startedAt;
        if (loaded > 0) etaMs = Math.max(0, (elapsed / loaded) * (total - loaded));
      }
      emitter.emit({
        id: entry.id,
        label: entry.label,
        fraction,
        etaMs,
        done: loaded,
        total,
        unit: 'bytes',
        phase: 'update',
      });
    },
    end(url) {
      const stack = inflight.get(url);
      const entry = stack?.shift();
      if (stack && stack.length === 0) inflight.delete(url);
      if (!entry) return;
      emitter.emit({
        id: entry.id,
        label: entry.label,
        fraction: 1,
        etaMs: 0,
        unit: 'bytes',
        phase: 'end',
      });
    },
  };
}
