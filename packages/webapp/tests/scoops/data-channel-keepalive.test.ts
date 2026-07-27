import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataChannelKeepalive } from '../../src/scoops/data-channel-keepalive.js';

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
    const keepalive = new DataChannelKeepalive({
      sendPing,
      onDead,
      intervalMs: 1000,
      maxMissed: 3,
    });
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
    const keepalive = new DataChannelKeepalive({
      sendPing,
      onDead,
      intervalMs: 1000,
      maxMissed: 3,
    });
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
    const keepalive = new DataChannelKeepalive({
      sendPing,
      onDead,
      intervalMs: 1000,
      maxMissed: 3,
    });
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
    const keepalive = new DataChannelKeepalive({
      sendPing,
      onDead,
      intervalMs: 1000,
      maxMissed: 3,
    });
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
    const keepalive = new DataChannelKeepalive({
      sendPing,
      onDead,
      intervalMs: 1000,
      maxMissed: 2,
    });
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

  // -------------------------------------------------------------------------
  // Stall vs death
  //
  // A peer that stops answering while its transport is still open is busy,
  // not gone. Killing the connection there is self-inflicted: it closes a
  // healthy channel and forces a full ICE/DTLS renegotiation.
  // -------------------------------------------------------------------------

  describe('stall handling (transport still open)', () => {
    /** Build a keepalive whose transport openness the test controls. */
    const makeStalling = (open: { value: boolean }, overrides = {}) => {
      const sendPing = vi.fn();
      const onDead = vi.fn();
      const onStalled = vi.fn();
      const onRecovered = vi.fn();
      const keepalive = new DataChannelKeepalive({
        sendPing,
        onDead,
        onStalled,
        onRecovered,
        isTransportOpen: () => open.value,
        intervalMs: 1000,
        maxMissed: 3,
        hardMaxMissed: 6,
        ...overrides,
      });
      return { keepalive, sendPing, onDead, onStalled, onRecovered };
    };

    it('reports a stall instead of death when the transport is still open', () => {
      const open = { value: true };
      const { keepalive, onDead, onStalled } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(4000); // tick 4 → missed=3 === maxMissed

      expect(onStalled).toHaveBeenCalledTimes(1);
      expect(onDead).not.toHaveBeenCalled();
      expect(keepalive.isStalled).toBe(true);

      keepalive.stop();
    });

    it('keeps probing while stalled instead of tearing down', () => {
      const open = { value: true };
      const { keepalive, sendPing, onDead } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(4000); // stalled
      const pingsAtStall = sendPing.mock.calls.length;
      vi.advanceTimersByTime(1000);

      expect(sendPing.mock.calls.length).toBeGreaterThan(pingsAtStall);
      expect(onDead).not.toHaveBeenCalled();

      keepalive.stop();
    });

    it('reports the stall once, not on every tick', () => {
      const open = { value: true };
      const { keepalive, onStalled } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(5000); // past maxMissed, before hardMaxMissed

      expect(onStalled).toHaveBeenCalledTimes(1);

      keepalive.stop();
    });

    it('recovers when the peer answers again, without ever dying', () => {
      const open = { value: true };
      const { keepalive, onDead, onStalled, onRecovered } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(4000); // stalled
      expect(onStalled).toHaveBeenCalledTimes(1);

      keepalive.receivePong();

      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(keepalive.isStalled).toBe(false);
      expect(keepalive.missed).toBe(0);

      // A recovered peer can stall again later.
      vi.advanceTimersByTime(4000);
      expect(onStalled).toHaveBeenCalledTimes(2);
      expect(onDead).not.toHaveBeenCalled();

      keepalive.stop();
    });

    it('an inbound ping also clears the stall', () => {
      const open = { value: true };
      const { keepalive, onRecovered } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(4000);
      keepalive.receivePing();

      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(keepalive.isStalled).toBe(false);

      keepalive.stop();
    });

    it('still dies once the hard deadline passes', () => {
      const open = { value: true };
      const { keepalive, onDead } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(4000); // stalled (missed=3)
      expect(onDead).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3000); // missed=6 === hardMaxMissed → dead

      expect(onDead).toHaveBeenCalledTimes(1);

      keepalive.stop();
    });

    it('dies at maxMissed when the transport is NOT open', () => {
      const open = { value: false };
      const { keepalive, onDead, onStalled } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(4000); // missed=3 with a dead transport

      expect(onDead).toHaveBeenCalledTimes(1);
      expect(onStalled).not.toHaveBeenCalled();

      keepalive.stop();
    });

    it('rejects a hard deadline that would never apply', () => {
      // `tick` only consults the hard deadline after maxMissed is crossed, so a
      // smaller hardMaxMissed would silently never fire.
      expect(
        () =>
          new DataChannelKeepalive({
            sendPing: vi.fn(),
            onDead: vi.fn(),
            maxMissed: 60,
            hardMaxMissed: 30,
          })
      ).toThrow(RangeError);
    });

    it.each([
      ['intervalMs', { intervalMs: 0 }],
      ['maxMissed', { maxMissed: -1 }],
      ['hardMaxMissed', { hardMaxMissed: 2.5 }],
    ])('rejects a non-positive-integer %s', (_name, overrides) => {
      expect(
        () => new DataChannelKeepalive({ sendPing: vi.fn(), onDead: vi.fn(), ...overrides })
      ).toThrow(RangeError);
    });

    it('does not report a recovery after it has already declared death', () => {
      const open = { value: true };
      const { keepalive, onDead, onRecovered } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(7000); // stalled, then past the hard deadline
      expect(onDead).toHaveBeenCalledTimes(1);
      expect(keepalive.isStalled).toBe(false);

      // A pong that arrives after the state machine gave up must not resurrect
      // it or claim a recovery.
      keepalive.receivePong();
      keepalive.receivePing();

      expect(onRecovered).not.toHaveBeenCalled();
      expect(keepalive.isStalled).toBe(false);
    });

    it('dies at maxMissed once an open transport closes mid-stall', () => {
      const open = { value: true };
      const { keepalive, onDead, onStalled } = makeStalling(open);
      keepalive.start();

      vi.advanceTimersByTime(4000); // stalled while open
      expect(onStalled).toHaveBeenCalledTimes(1);
      expect(onDead).not.toHaveBeenCalled();

      open.value = false; // transport really went away
      vi.advanceTimersByTime(1000);

      expect(onDead).toHaveBeenCalledTimes(1);

      keepalive.stop();
    });
  });
});
