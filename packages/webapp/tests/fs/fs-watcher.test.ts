import { describe, it, expect, vi } from 'vitest';
import { FsWatcher, type FsChangeEvent } from '../../src/fs/fs-watcher.js';

describe('FsWatcher', () => {
  it('notifies matching watchers', () => {
    const watcher = new FsWatcher();
    const callback = vi.fn();
    watcher.watch('/workspace', (p) => p.endsWith('.ts'), callback);

    watcher.notify([{ type: 'create', path: '/workspace/src/foo.ts', entryType: 'file' }]);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toEqual([
      { type: 'create', path: '/workspace/src/foo.ts', entryType: 'file' },
    ]);
  });

  it('does not notify for non-matching paths', () => {
    const watcher = new FsWatcher();
    const callback = vi.fn();
    watcher.watch('/workspace', (p) => p.endsWith('.ts'), callback);

    watcher.notify([{ type: 'create', path: '/shared/foo.ts' }]);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not notify for filtered-out files', () => {
    const watcher = new FsWatcher();
    const callback = vi.fn();
    watcher.watch('/workspace', (p) => p.endsWith('.ts'), callback);

    watcher.notify([{ type: 'create', path: '/workspace/src/foo.js' }]);
    expect(callback).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', () => {
    const watcher = new FsWatcher();
    const callback = vi.fn();
    const unsub = watcher.watch('/workspace', () => true, callback);

    unsub();
    watcher.notify([{ type: 'create', path: '/workspace/foo.txt' }]);
    expect(callback).not.toHaveBeenCalled();
  });

  it('dispose removes all watchers', () => {
    const watcher = new FsWatcher();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    watcher.watch('/workspace', () => true, cb1);
    watcher.watch('/shared', () => true, cb2);

    expect(watcher.size).toBe(2);
    watcher.dispose();
    expect(watcher.size).toBe(0);

    watcher.notify([{ type: 'create', path: '/workspace/foo.txt' }]);
    expect(cb1).not.toHaveBeenCalled();
  });

  it('batches multiple events to a single callback', () => {
    const watcher = new FsWatcher();
    const callback = vi.fn();
    watcher.watch('/workspace', () => true, callback);

    watcher.notify([
      { type: 'create', path: '/workspace/a.txt' },
      { type: 'modify', path: '/workspace/b.txt' },
    ]);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toHaveLength(2);
  });

  it('callback errors do not prevent other watchers from firing', () => {
    const watcher = new FsWatcher();
    const badCallback = vi.fn(() => {
      throw new Error('oops');
    });
    const goodCallback = vi.fn();
    watcher.watch('/workspace', () => true, badCallback);
    watcher.watch('/workspace', () => true, goodCallback);

    watcher.notify([{ type: 'create', path: '/workspace/foo.txt' }]);
    expect(badCallback).toHaveBeenCalled();
    expect(goodCallback).toHaveBeenCalled();
  });

  it('multiple watchers on different base paths', () => {
    const watcher = new FsWatcher();
    const wsCb = vi.fn();
    const sharedCb = vi.fn();
    watcher.watch('/workspace', () => true, wsCb);
    watcher.watch('/shared', () => true, sharedCb);

    watcher.notify([{ type: 'modify', path: '/workspace/foo.txt' }]);
    expect(wsCb).toHaveBeenCalled();
    expect(sharedCb).not.toHaveBeenCalled();
  });

  it('does not match sibling prefixes outside the watched subtree', () => {
    const watcher = new FsWatcher();
    const callback = vi.fn();
    watcher.watch('/workspace', () => true, callback);

    watcher.notify([{ type: 'create', path: '/workspace-tools/foo.txt' }]);

    expect(callback).not.toHaveBeenCalled();
  });
});
