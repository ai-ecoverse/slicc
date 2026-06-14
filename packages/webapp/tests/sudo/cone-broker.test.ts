/**
 * Tests for the cone-approval sudo broker and its pending-request registry.
 *
 * The broker is the seam between a scoop's gated FS/shell call and the
 * cone agent's decision. These tests pin its three exit paths:
 *   - allow / deny / always (driven by `resolve()` like the cone would)
 *   - timeout (fail-closed deny, fake timer)
 *   - scoop drop / shutdown (fail-closed deny, registry-level)
 * plus the orchestrator-facing surfaces (router shim, id generation,
 * idempotent resolve).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CONE_SUDO_TIMEOUT_MS,
  ConeRequestRegistry,
  createConeApprovalBroker,
} from '../../src/sudo/cone-broker.js';
import type { SudoDecision, SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };

function makeRegistry(overrides: Partial<{ timeoutMs: number; ids: string[] }> = {}) {
  const ids = overrides.ids ?? ['sudo-1', 'sudo-2', 'sudo-3'];
  let i = 0;
  const timers = new Set<() => void>();
  const setTimer = vi.fn((cb: () => void) => {
    timers.add(cb);
    return cb;
  });
  const clearTimer = vi.fn((handle: unknown) => {
    timers.delete(handle as () => void);
  });
  const registry = new ConeRequestRegistry({
    timeoutMs: overrides.timeoutMs ?? CONE_SUDO_TIMEOUT_MS,
    newId: () => {
      const id = ids[i] ?? `sudo-fallback-${i}`;
      i++;
      return id;
    },
    setTimer,
    clearTimer,
  });
  const fireAllTimers = () => {
    for (const cb of timers) cb();
  };
  return { registry, setTimer, clearTimer, fireAllTimers };
}

describe('createConeApprovalBroker', () => {
  it('forwards requestApproval through the router with the scoop jid', async () => {
    const enqueueSudoRequest = vi.fn(async () => ({ decision: 'allow' }) as SudoDecision);
    const broker = createConeApprovalBroker('scoop_abc', { enqueueSudoRequest });

    const decision = await broker.requestApproval(REQ);

    expect(decision).toEqual({ decision: 'allow' });
    expect(enqueueSudoRequest).toHaveBeenCalledWith('scoop_abc', REQ);
  });

  it('propagates router rejections to the caller', async () => {
    const err = new Error('cone offline');
    const broker = createConeApprovalBroker('scoop_x', {
      enqueueSudoRequest: () => Promise.reject(err),
    });
    await expect(broker.requestApproval(REQ)).rejects.toBe(err);
  });
});

describe('ConeRequestRegistry.register + resolve', () => {
  it('resolves the pending promise with the cone decision (allow)', async () => {
    const { registry } = makeRegistry();
    const { id, pending } = registry.register('scoop_a', REQ);
    expect(id).toBe('sudo-1');
    expect(registry.size()).toBe(1);

    const settled = registry.resolve(id, { decision: 'allow' });
    expect(settled).toBe(true);
    await expect(pending).resolves.toEqual({ decision: 'allow' });
    expect(registry.size()).toBe(0);
  });

  it('passes through a deny decision', async () => {
    const { registry } = makeRegistry();
    const { id, pending } = registry.register('scoop_a', REQ);
    registry.resolve(id, { decision: 'deny' });
    await expect(pending).resolves.toEqual({ decision: 'deny' });
  });

  it('passes through an always decision with its pattern', async () => {
    const { registry } = makeRegistry();
    const { id, pending } = registry.register('scoop_a', REQ);
    registry.resolve(id, { decision: 'always', pattern: 'git push*' });
    await expect(pending).resolves.toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('clears the timer when a request resolves normally', () => {
    const { registry, clearTimer } = makeRegistry();
    const { id } = registry.register('scoop_a', REQ);
    expect(clearTimer).not.toHaveBeenCalled();
    registry.resolve(id, { decision: 'allow' });
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it('snapshots pending requests via get / list', () => {
    const { registry } = makeRegistry();
    const { id: id1 } = registry.register('scoop_a', REQ);
    const { id: id2 } = registry.register('scoop_b', { kind: 'write', detail: '/etc/passwd' });

    expect(registry.get(id1)).toEqual({ id: id1, scoopJid: 'scoop_a', request: REQ });
    expect(registry.list().map((r) => r.id)).toEqual([id1, id2]);
    expect(registry.size()).toBe(2);
    expect(registry.get('does-not-exist')).toBeNull();
  });
});

describe('ConeRequestRegistry.resolve idempotency', () => {
  it('returns false for an unknown id and never settles an unrelated entry', async () => {
    const { registry } = makeRegistry();
    const { id, pending } = registry.register('scoop_a', REQ);

    expect(registry.resolve('does-not-exist', { decision: 'allow' })).toBe(false);
    expect(registry.size()).toBe(1);

    registry.resolve(id, { decision: 'allow' });
    await expect(pending).resolves.toEqual({ decision: 'allow' });
  });

  it('returns false on the second resolve of the same id (first wins)', async () => {
    const { registry } = makeRegistry();
    const { id, pending } = registry.register('scoop_a', REQ);

    expect(registry.resolve(id, { decision: 'allow' })).toBe(true);
    expect(registry.resolve(id, { decision: 'deny' })).toBe(false);
    await expect(pending).resolves.toEqual({ decision: 'allow' });
  });
});

describe('ConeRequestRegistry fail-closed paths', () => {
  it('resolves deny when the per-request timer fires', async () => {
    const { registry, fireAllTimers } = makeRegistry();
    const { pending } = registry.register('scoop_a', REQ);
    fireAllTimers();
    await expect(pending).resolves.toEqual({ decision: 'deny' });
    expect(registry.size()).toBe(0);
  });

  it('failScoop denies every request from the given scoop and leaves others', async () => {
    const { registry } = makeRegistry({ ids: ['a1', 'a2', 'b1'] });
    const { pending: pendingA1 } = registry.register('scoop_a', REQ);
    const { pending: pendingA2 } = registry.register('scoop_a', REQ);
    const { id: b1Id, pending: pendingB1 } = registry.register('scoop_b', REQ);

    expect(registry.failScoop('scoop_a')).toBe(2);
    await expect(pendingA1).resolves.toEqual({ decision: 'deny' });
    await expect(pendingA2).resolves.toEqual({ decision: 'deny' });
    expect(registry.size()).toBe(1);

    // Untouched scoop_b request still resolvable.
    expect(registry.resolve(b1Id, { decision: 'allow' })).toBe(true);
    await expect(pendingB1).resolves.toEqual({ decision: 'allow' });
  });

  it('failAll denies every pending request and clears the registry', async () => {
    const { registry } = makeRegistry();
    const { pending: p1 } = registry.register('scoop_a', REQ);
    const { pending: p2 } = registry.register('scoop_b', REQ);

    expect(registry.failAll()).toBe(2);
    await expect(p1).resolves.toEqual({ decision: 'deny' });
    await expect(p2).resolves.toEqual({ decision: 'deny' });
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('cancels the per-request timer when failScoop drains the entry', () => {
    const { registry, clearTimer } = makeRegistry();
    registry.register('scoop_a', REQ);
    registry.failScoop('scoop_a');
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it('cancels every per-request timer when failAll drains the registry', () => {
    const { registry, clearTimer } = makeRegistry();
    registry.register('scoop_a', REQ);
    registry.register('scoop_b', REQ);
    registry.failAll();
    expect(clearTimer).toHaveBeenCalledTimes(2);
  });
});

describe('ConeRequestRegistry timeout configuration', () => {
  it('does NOT install a timer when timeoutMs <= 0', () => {
    const { registry, setTimer } = makeRegistry({ timeoutMs: 0 });
    registry.register('scoop_a', REQ);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it('does NOT install a timer when timeoutMs is Infinity', () => {
    const { registry, setTimer } = makeRegistry({ timeoutMs: Number.POSITIVE_INFINITY });
    registry.register('scoop_a', REQ);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it('uses real setTimeout / clearTimeout when no overrides are passed', async () => {
    vi.useFakeTimers();
    try {
      const registry = new ConeRequestRegistry({ timeoutMs: 100, newId: () => 'sudo-real' });
      const { id, pending } = registry.register('scoop_a', REQ);
      vi.advanceTimersByTime(99);
      expect(registry.size()).toBe(1);
      vi.advanceTimersByTime(2);
      await expect(pending).resolves.toEqual({ decision: 'deny' });
      // Subsequent resolve is a no-op (entry already drained by the timer).
      expect(registry.resolve(id, { decision: 'allow' })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
