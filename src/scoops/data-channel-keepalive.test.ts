import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DataChannelKeepalive } from './data-channel-keepalive.js';

describe('DataChannelKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends pings at the configured interval', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000 });
    keepalive.start();

    vi.advanceTimersByTime(1000);
    expect(sendPing).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(sendPing).toHaveBeenCalledTimes(2);

    keepalive.stop();
  });

  it('does not fire onDead when pongs arrive in time', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000, maxMissed: 3 });
    keepalive.start();

    // Tick 1: sends ping
    vi.advanceTimersByTime(1000);
    keepalive.receivePong();

    // Tick 2: sends ping
    vi.advanceTimersByTime(1000);
    keepalive.receivePong();

    // Tick 3: sends ping
    vi.advanceTimersByTime(1000);
    keepalive.receivePong();

    expect(onDead).not.toHaveBeenCalled();
    expect(keepalive.missed).toBe(0);
    keepalive.stop();
  });

  it('fires onDead after maxMissed consecutive missed pongs', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000, maxMissed: 3 });
    keepalive.start();

    // Tick 1: ping sent, no pong
    vi.advanceTimersByTime(1000);
    expect(keepalive.missed).toBe(0); // first ping just sent, not missed yet

    // Tick 2: previous pong missed (missed=1), new ping sent
    vi.advanceTimersByTime(1000);
    expect(keepalive.missed).toBe(1);

    // Tick 3: missed=2, new ping sent
    vi.advanceTimersByTime(1000);
    expect(keepalive.missed).toBe(2);

    // Tick 4: missed=3 → dead
    vi.advanceTimersByTime(1000);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(keepalive.missed).toBe(3);
  });

  it('resets missed count when a pong arrives', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000, maxMissed: 3 });
    keepalive.start();

    // Miss 2 pongs
    vi.advanceTimersByTime(1000); // ping sent
    vi.advanceTimersByTime(1000); // missed=1, ping sent
    vi.advanceTimersByTime(1000); // missed=2, ping sent
    expect(keepalive.missed).toBe(2);

    // Pong arrives
    keepalive.receivePong();
    expect(keepalive.missed).toBe(0);

    // Need 3 more misses to trigger dead
    vi.advanceTimersByTime(1000); // ping sent
    vi.advanceTimersByTime(1000); // missed=1
    vi.advanceTimersByTime(1000); // missed=2
    expect(onDead).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // missed=3 → dead
    expect(onDead).toHaveBeenCalledTimes(1);

    keepalive.stop();
  });

  it('resets missed count when a ping is received from the remote side', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000, maxMissed: 3 });
    keepalive.start();

    // Miss 2 pongs
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(keepalive.missed).toBe(2);

    // Receiving a ping from remote also proves liveness
    keepalive.receivePing();
    expect(keepalive.missed).toBe(0);

    keepalive.stop();
  });

  it('stops sending pings after stop()', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000 });
    keepalive.start();

    vi.advanceTimersByTime(1000);
    expect(sendPing).toHaveBeenCalledTimes(1);

    keepalive.stop();

    vi.advanceTimersByTime(5000);
    expect(sendPing).toHaveBeenCalledTimes(1);
  });

  it('stops the interval after declaring dead', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000, maxMissed: 2 });
    keepalive.start();

    // Trigger dead (maxMissed=2)
    vi.advanceTimersByTime(1000); // ping sent
    vi.advanceTimersByTime(1000); // missed=1, ping sent
    vi.advanceTimersByTime(1000); // missed=2 → dead
    expect(onDead).toHaveBeenCalledTimes(1);

    const callCount = sendPing.mock.calls.length;
    vi.advanceTimersByTime(5000);
    // No more pings after dead
    expect(sendPing).toHaveBeenCalledTimes(callCount);
  });

  it('uses defaults of 10s interval and 3 max missed', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead });
    keepalive.start();

    // Should not ping before 10s
    vi.advanceTimersByTime(9999);
    expect(sendPing).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(sendPing).toHaveBeenCalledTimes(1);

    // Need 3 missed + the initial ping = 4 ticks total to trigger dead
    vi.advanceTimersByTime(10000); // missed=1
    vi.advanceTimersByTime(10000); // missed=2
    vi.advanceTimersByTime(10000); // missed=3 → dead
    expect(onDead).toHaveBeenCalledTimes(1);

    keepalive.stop();
  });

  it('start() is idempotent', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000 });
    keepalive.start();
    keepalive.start(); // second call should be no-op

    vi.advanceTimersByTime(1000);
    expect(sendPing).toHaveBeenCalledTimes(1); // not 2

    keepalive.stop();
  });

  it('cannot restart after stop()', () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const keepalive = new DataChannelKeepalive({ sendPing, onDead, intervalMs: 1000 });
    keepalive.start();
    keepalive.stop();
    keepalive.start(); // should be no-op

    vi.advanceTimersByTime(5000);
    expect(sendPing).not.toHaveBeenCalled();
  });
});
