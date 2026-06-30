/**
 * Unit coverage for LickbackRegistry — the cup-owned, atomic claim +
 * per-channel bounded outbound queue + SSE drain subscription with lease/GC.
 *
 * Determinism: the registry takes an injected `now()` clock; every lease/GC
 * assertion advances a mutable fake clock rather than wall time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createLickbackRegistry } from '../../src/routes/lickback-registry.js';

const LEASE = 45_000;

describe('LickbackRegistry — claim ownership', () => {
  let clock: { t: number };
  let now: () => number;

  beforeEach(() => {
    clock = { t: 1000 };
    now = () => clock.t;
  });

  it('first caller wins the channel', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    const res = reg.claim('chat', 'sess-A');
    expect(res).toEqual({ ok: true, owner: 'sess-A', leaseMs: LEASE });
    expect(reg.isOwner('chat', 'sess-A')).toBe(true);
  });

  it('a second, different, non-expired session is rejected with the current owner', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    const res = reg.claim('chat', 'sess-B');
    expect(res).toEqual({ ok: false, owner: 'sess-A' });
    expect(reg.isOwner('chat', 'sess-B')).toBe(false);
  });

  it('re-claim by the current owner renews (still ok)', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    clock.t += LEASE - 1; // not yet expired
    const res = reg.claim('chat', 'sess-A');
    expect(res).toEqual({ ok: true, owner: 'sess-A', leaseMs: LEASE });
  });

  it('a new session can claim after the owner lease expires', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    clock.t += LEASE; // lease elapsed (>= leaseMs idle)
    const res = reg.claim('chat', 'sess-B');
    expect(res).toEqual({ ok: true, owner: 'sess-B', leaseMs: LEASE });
    expect(reg.isOwner('chat', 'sess-A')).toBe(false);
  });

  it('channels are independent — claiming one does not claim another', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    expect(reg.claim('other', 'sess-B')).toEqual({ ok: true, owner: 'sess-B', leaseMs: LEASE });
  });
});

describe('LickbackRegistry — heartbeat', () => {
  let clock: { t: number };
  let now: () => number;

  beforeEach(() => {
    clock = { t: 1000 };
    now = () => clock.t;
  });

  it('owner heartbeat renews the lease and returns true', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    clock.t += LEASE - 1;
    expect(reg.heartbeat('chat', 'sess-A')).toBe(true);
    // After the renew, advancing another (leaseMs-1) still keeps A's claim.
    clock.t += LEASE - 1;
    expect(reg.claim('chat', 'sess-B')).toEqual({ ok: false, owner: 'sess-A' });
  });

  it('non-owner heartbeat returns false and does not steal the channel', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    expect(reg.heartbeat('chat', 'sess-B')).toBe(false);
    expect(reg.isOwner('chat', 'sess-A')).toBe(true);
  });

  it('heartbeat on an unclaimed channel returns false', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    expect(reg.heartbeat('chat', 'sess-A')).toBe(false);
  });
});

describe('LickbackRegistry — enqueue + subscribe drain', () => {
  let clock: { t: number };
  let now: () => number;

  beforeEach(() => {
    clock = { t: 1000 };
    now = () => clock.t;
  });

  it('flushes ONE buffered event per connection, keeping the rest queued (F1)', () => {
    // The lick-back consumer (lickback-wait) takes one frame per SSE connection and
    // exits, so flushing the whole backlog into one connection would drop events
    // 2..N. subscribe must deliver only the OLDEST buffered event and requeue the
    // rest, so successive connections drain the backlog loss-free, in order.
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    reg.enqueue('chat', { n: 1 });
    reg.enqueue('chat', { n: 2 });
    reg.enqueue('chat', { n: 3 });

    const r1: unknown[] = [];
    const s1 = reg.subscribe('chat', 'sess-A', (e) => r1.push(e));
    if (!s1.ok) throw new Error('expected ok subscribe');
    expect(r1).toEqual([{ n: 1 }]); // only the oldest
    s1.unsubscribe();

    const r2: unknown[] = [];
    reg.subscribe('chat', 'sess-A', (e) => r2.push(e));
    expect(r2).toEqual([{ n: 2 }]); // next connection gets the next one
  });

  it('delivers live to an attached drain without buffering', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    const received: unknown[] = [];
    reg.subscribe('chat', 'sess-A', (e) => received.push(e));
    reg.enqueue('chat', { n: 1 });
    reg.enqueue('chat', { n: 2 });
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('rejects a drain from a non-owner with the current owner', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    const sub = reg.subscribe('chat', 'sess-B', () => undefined);
    expect(sub).toEqual({ ok: false, owner: 'sess-A' });
  });

  it('rejects a drain on an unclaimed channel (owner null)', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    const sub = reg.subscribe('chat', 'sess-A', () => undefined);
    expect(sub).toEqual({ ok: false, owner: null });
  });

  it('drops the oldest event and reports it when the queue overflows with no drain', () => {
    const drops: unknown[] = [];
    const reg = createLickbackRegistry({
      now,
      leaseMs: LEASE,
      queueMax: 2,
      onDrop: (_channel, event) => drops.push(event),
    });
    reg.claim('chat', 'sess-A');
    reg.enqueue('chat', { n: 1 });
    reg.enqueue('chat', { n: 2 });
    reg.enqueue('chat', { n: 3 }); // overflow → drop { n: 1 }

    expect(drops).toEqual([{ n: 1 }]);
    const received: unknown[] = [];
    reg.subscribe('chat', 'sess-A', (e) => received.push(e));
    expect(received).toEqual([{ n: 2 }]); // flush-one: { n: 3 } stays queued (F1)
  });

  it('buffers events even before any claim, for a later owner to drain', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.enqueue('chat', { orphan: true }); // e.g. an upgrade lick before anyone claimed
    reg.claim('chat', 'sess-A');
    const received: unknown[] = [];
    reg.subscribe('chat', 'sess-A', (e) => received.push(e));
    expect(received).toEqual([{ orphan: true }]);
  });

  it('unsubscribe stops live delivery and re-buffers subsequent events', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    const received: unknown[] = [];
    const sub = reg.subscribe('chat', 'sess-A', (e) => received.push(e));
    if (!sub.ok) throw new Error('expected ok subscribe');
    reg.enqueue('chat', { n: 1 });
    sub.unsubscribe();
    reg.enqueue('chat', { n: 2 }); // no live drain → buffered
    expect(received).toEqual([{ n: 1 }]);

    const received2: unknown[] = [];
    reg.subscribe('chat', 'sess-A', (e) => received2.push(e));
    expect(received2).toEqual([{ n: 2 }]);
  });
});

describe('LickbackRegistry — lease while draining', () => {
  let clock: { t: number };
  let now: () => number;

  beforeEach(() => {
    clock = { t: 1000 };
    now = () => clock.t;
  });

  it('an open drain holds the lease open past the idle window', () => {
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    const sub = reg.subscribe('chat', 'sess-A', () => undefined);
    if (!sub.ok) throw new Error('expected ok subscribe');

    clock.t += LEASE * 3; // way past idle, but the drain is held
    expect(reg.claim('chat', 'sess-B')).toEqual({ ok: false, owner: 'sess-A' });

    // After the drain drops, the lease ticks from the disconnect moment.
    sub.unsubscribe();
    clock.t += LEASE;
    expect(reg.claim('chat', 'sess-B')).toEqual({ ok: true, owner: 'sess-B', leaseMs: LEASE });
  });

  it("a stale first-drain's late unsubscribe does not unpin the live second drain (F2)", () => {
    // A reconnect races the old socket's close: drain #2 subscribes for the same
    // owner BEFORE drain #1's `res.on('close')` finally fires. #1's unsubscribe
    // must not flip the shared draining/lastActivity state — it no longer owns it.
    const reg = createLickbackRegistry({ now, leaseMs: LEASE });
    reg.claim('chat', 'sess-A');
    const got1: unknown[] = [];
    const got2: unknown[] = [];
    const sub1 = reg.subscribe('chat', 'sess-A', (e) => got1.push(e));
    const sub2 = reg.subscribe('chat', 'sess-A', (e) => got2.push(e));
    if (!sub1.ok || !sub2.ok) throw new Error('expected ok subscribes');

    sub1.unsubscribe(); // the first socket's close, arriving late

    // The live second drain still pins the channel past the full idle window...
    clock.t += LEASE * 2;
    expect(reg.claim('chat', 'sess-B')).toEqual({ ok: false, owner: 'sess-A' });
    // ...and live events keep reaching it, not a silently-dropped buffer.
    reg.enqueue('chat', { n: 1 });
    expect(got2).toEqual([{ n: 1 }]);
    expect(got1).toEqual([]);
  });
});
