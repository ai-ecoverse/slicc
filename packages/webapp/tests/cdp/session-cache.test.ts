import { describe, expect, it, vi } from 'vitest';

import { SessionCache, type TabSession } from '../../src/cdp/session-cache.js';
import type { CDPTransport } from '../../src/cdp/transport.js';

function fakeTransport(): CDPTransport {
  return {
    state: 'connected',
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
  } as unknown as CDPTransport;
}

function entry(
  sessionId: string,
  transport: CDPTransport,
  remote?: TabSession['remote']
): TabSession {
  return remote ? { sessionId, transport, remote } : { sessionId, transport };
}

describe('SessionCache', () => {
  it('remembers and retrieves sessions by target id', () => {
    const cache = new SessionCache(4);
    const transport = fakeTransport();
    cache.remember('t1', entry('sess-1', transport));

    expect(cache.size).toBe(1);
    expect(cache.get('t1')?.sessionId).toBe('sess-1');
    expect(cache.has('t1')).toBe(true);
    expect(cache.has('t2')).toBe(false);
  });

  it('evicts the least-recently-used unpinned session over the cap', () => {
    const evicted: string[] = [];
    const cache = new SessionCache(2, (targetId) => {
      evicted.push(targetId);
    });
    const transport = fakeTransport();
    cache.remember('t1', entry('sess-1', transport));
    cache.remember('t2', entry('sess-2', transport));
    cache.touch('t1', entry('sess-1', transport));
    cache.remember('t3', entry('sess-3', transport));

    expect(evicted).toEqual(['t2']);
    expect(cache.has('t2')).toBe(false);
    expect(cache.has('t1')).toBe(true);
    expect(cache.has('t3')).toBe(true);
  });

  it('skips pinned sessions and retries eviction on pin release', () => {
    const evicted: string[] = [];
    const cache = new SessionCache(1, (targetId) => {
      evicted.push(targetId);
    });
    const transport = fakeTransport();
    cache.remember('t1', entry('sess-1', transport));
    const unpinBusy = cache.pin('t1');
    cache.remember('t-extra', entry('sess-extra', transport));

    expect(evicted).toEqual([]);
    expect(cache.size).toBe(2);

    const unpinExtra = cache.pin('t-extra');
    expect(evicted).toEqual([]);
    unpinExtra();
    expect(evicted).toEqual(['t-extra']);
    expect(cache.has('t1')).toBe(true);
    expect(cache.has('t-extra')).toBe(false);
    unpinBusy();
  });

  it('nested pins only clear isPinned after the last unpin', () => {
    const cache = new SessionCache(4);
    const transport = fakeTransport();
    cache.remember('t1', entry('sess-1', transport));
    const unpinOuter = cache.pin('t1');
    const unpinInner = cache.pin('t1');

    unpinInner();
    expect(cache.isPinned('t1')).toBe(true);

    unpinOuter();
    expect(cache.isPinned('t1')).toBe(false);
  });

  it('idempotent pin release does not over-decrement', () => {
    const cache = new SessionCache(2);
    const transport = fakeTransport();
    cache.remember('t1', entry('sess-1', transport));
    const unpin = cache.pin('t1');
    unpin();
    unpin();
    expect(cache.isPinned('t1')).toBe(false);
  });

  it('tracks applied sends and prunes counters for dead sessions past the bound', () => {
    const cache = new SessionCache(2);
    const transport = fakeTransport();
    cache.remember('t1', entry('sess-1', transport));
    cache.noteApplied('sess-1');
    cache.noteApplied('sess-1');
    expect(cache.appliedCount('sess-1')).toBe(2);

    for (let i = 0; i < 10; i++) cache.noteApplied(`orphan-${i}`);
    expect(cache.appliedCount('orphan-0')).toBe(1);

    cache.remember('t2', entry('sess-2', transport));
    expect(cache.appliedCount('sess-1')).toBe(2);
    expect(cache.appliedCount('orphan-0')).toBe(0);
  });

  it('findBySessionId and findByTargetOrLocalId locate registry entries', () => {
    const cache = new SessionCache(4);
    const local = fakeTransport();
    const remote = fakeTransport();
    cache.remember('local-1', entry('sess-local', local));
    cache.remember(
      'rt:tab-9',
      entry('sess-remote', remote, { runtimeId: 'rt', localTargetId: 'tab-9' })
    );

    expect(cache.findBySessionId('sess-remote')?.[0]).toBe('rt:tab-9');
    expect(cache.findByTargetOrLocalId('tab-9').map(([id]) => id)).toEqual(['rt:tab-9']);
    expect(cache.findByTargetOrLocalId('local-1').map(([id]) => id)).toEqual(['local-1']);
  });

  it('anyOnTransport / anyMatchingRemote report remaining users', () => {
    const cache = new SessionCache(4);
    const a = fakeTransport();
    const b = fakeTransport();
    cache.remember('t1', entry('sess-1', a, { runtimeId: 'rt', localTargetId: 'x' }));
    cache.remember('t2', entry('sess-2', a, { runtimeId: 'rt', localTargetId: 'x' }));

    expect(cache.anyOnTransport(a)).toBe(true);
    expect(cache.anyOnTransport(b)).toBe(false);
    expect(cache.anyMatchingRemote('rt', 'x')).toBe(true);

    cache.take('t1');
    expect(cache.anyMatchingRemote('rt', 'x')).toBe(true);
    cache.take('t2');
    expect(cache.anyMatchingRemote('rt', 'x')).toBe(false);
    expect(cache.anyOnTransport(a)).toBe(false);
  });

  it('snapshot is stable while the cache mutates during iteration', () => {
    const cache = new SessionCache(4);
    const transport = fakeTransport();
    cache.remember('t1', entry('sess-1', transport));
    cache.remember('t2', entry('sess-2', transport));

    const seen: string[] = [];
    for (const [targetId] of cache.snapshot()) {
      seen.push(targetId);
      cache.delete(targetId);
    }
    expect(seen).toEqual(['t1', 't2']);
    expect(cache.size).toBe(0);
  });

  it('protects the just-inserted entry from immediate eviction', () => {
    const evicted: string[] = [];
    const cache = new SessionCache(1, (targetId) => {
      evicted.push(targetId);
    });
    const transport = fakeTransport();
    cache.remember('t1', entry('sess-1', transport));
    cache.remember('t2', entry('sess-2', transport));

    expect(evicted).toEqual(['t1']);
    expect(cache.get('t2')?.sessionId).toBe('sess-2');
  });
});
