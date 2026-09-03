import type { FSWatcher } from 'fs';
import { describe, expect, it, vi } from 'vitest';

import {
  buildHostfsInvalidateEvent,
  startHostFsWatchers,
  toMountRelativePath,
} from '../src/hostfs-watch.js';

describe('toMountRelativePath', () => {
  it('maps a relative filename under the root', () => {
    expect(toMountRelativePath('/Users/me/kb', 'notes.md')).toBe('notes.md');
    expect(toMountRelativePath('/Users/me/kb', 'sub/a.txt')).toBe('sub/a.txt');
  });

  it('returns empty string for a null/empty filename (whole-mount signal)', () => {
    expect(toMountRelativePath('/Users/me/kb', null)).toBe('');
    expect(toMountRelativePath('/Users/me/kb', '')).toBe('');
  });

  it('rejects escapes outside the root', () => {
    expect(toMountRelativePath('/Users/me/kb', '../secret')).toBeNull();
  });
});

describe('buildHostfsInvalidateEvent', () => {
  it('dedupes paths and clears the mount on overflow or empty path', () => {
    expect(buildHostfsInvalidateEvent('/mnt/kb', ['a', 'a', 'b']).paths).toEqual(['a', 'b']);
    expect(buildHostfsInvalidateEvent('/mnt/kb', ['', 'a']).paths).toEqual([]);
    expect(buildHostfsInvalidateEvent('/mnt/kb', ['a', 'b'], 1).paths).toEqual([]);
  });
});

describe('startHostFsWatchers', () => {
  it('debounces and broadcasts coalesced hostfs_invalidate events', async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    let listener: ((event: string, filename: string | null) => void) | undefined;
    const watchFn = vi.fn(
      (
        _root: string,
        _opts: { recursive?: boolean },
        cb: (event: string, filename: string | null) => void
      ) => {
        listener = cb;
        return {
          on: () => undefined,
          close: () => undefined,
        } as unknown as FSWatcher;
      }
    );

    const handle = startHostFsWatchers(
      [{ path: '/mnt/kb', root: '/h/kb' }],
      (event) => events.push(event),
      { watchFn: watchFn as unknown as typeof import('fs').watch, debounceMs: 50 }
    );

    expect(watchFn).toHaveBeenCalledOnce();
    expect(listener).toBeTypeOf('function');
    listener!('change', 'a.txt');
    listener!('change', 'a.txt');
    listener!('change', 'b.txt');
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'hostfs_invalidate',
      mount: '/mnt/kb',
      paths: expect.arrayContaining(['a.txt', 'b.txt']),
    });

    handle.stop();
    vi.useRealTimers();
  });
});
