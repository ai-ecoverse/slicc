/**
 * Chrome-leg reconnect supervisor for the `/cdp` proxy (issue #2417,
 * `DIAGNOSIS.md` §2.6 / phase 3.1). Pins the swift-server parity behaviour:
 * schedule once per drop, retry with a delay, re-discover the ws URL, and
 * close the active client with 4002 once the leg is back — or once it is
 * definitively gone — so the page resets its dead sessions. Also pins that
 * shutdown cancels the loop instead of reconnecting a browser we're closing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHROME_RECONNECT_DELAY_MS,
  CHROME_RECONNECT_MAX_ATTEMPTS,
  type ChromeLegState,
  ChromeReconnectController,
  type ChromeReconnectDeps,
  closeClientForUpstreamReset,
  markChromeLegDown,
} from '../../src/cdp-proxy/chrome-reconnect.js';
import {
  CDP_UPSTREAM_RESET_CLOSE_CODE,
  CDP_UPSTREAM_RESET_CLOSE_REASON,
} from '../../src/cdp-proxy/close-codes.js';

interface Harness {
  controller: ChromeReconnectController;
  logs: string[];
  resets: string[];
  discover: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  sleeps: number[];
  shuttingDown: { value: boolean };
}

function makeHarness(overrides: Partial<ChromeReconnectDeps> = {}): Harness {
  const logs: string[] = [];
  const resets: string[] = [];
  const sleeps: number[] = [];
  const shuttingDown = { value: false };
  const discover = vi.fn(async () => 'ws://127.0.0.1:9222/devtools/browser/fresh');
  const connect = vi.fn(async () => {});

  const controller = new ChromeReconnectController({
    discoverChromeWsUrl: discover,
    connectChrome: connect,
    resetClient: (reason) => resets.push(reason),
    isShuttingDown: () => shuttingDown.value,
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });

  return { controller, logs, resets, discover, connect, sleeps, shuttingDown };
}

describe('ChromeReconnectController', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('schedules a reconnect, re-discovers the ws URL and reconnects', async () => {
    h.controller.schedule('close code=1006');
    await h.controller.settled();

    expect(h.sleeps).toEqual([CHROME_RECONNECT_DELAY_MS]);
    expect(h.discover).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledWith('ws://127.0.0.1:9222/devtools/browser/fresh');
    expect(h.logs).toContain(
      `[cdp-proxy] Scheduling Chrome WS reconnect in ${CHROME_RECONNECT_DELAY_MS}ms (close code=1006)`
    );
    expect(h.logs).toContain('[cdp-proxy] Chrome WS auto-reconnected');
  });

  it('resets the active client once the Chrome leg is back', async () => {
    h.controller.schedule('close code=1009');
    await h.controller.settled();

    expect(h.resets).toEqual(['reconnected']);
  });

  it('is idempotent — an error plus a close schedules one loop', async () => {
    const deferred: { release?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      deferred.release = resolve;
    });
    const harness = makeHarness({
      sleep: async () => {
        await gate;
      },
    });

    harness.controller.schedule('error: boom');
    harness.controller.schedule('close code=1006');
    expect(harness.controller.reconnecting).toBe(true);

    deferred.release?.();
    await harness.controller.settled();

    expect(harness.discover).toHaveBeenCalledTimes(1);
    expect(harness.controller.reconnecting).toBe(false);
  });

  it('retries after a failed attempt and reports each failure', async () => {
    let calls = 0;
    const harness = makeHarness({
      connectChrome: async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNREFUSED');
      },
    });

    harness.controller.schedule('close code=1006');
    await harness.controller.settled();

    expect(calls).toBe(3);
    expect(harness.sleeps).toHaveLength(3);
    const failures = harness.logs.filter((l) => l.includes('Auto-reconnect attempt'));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(
      new RegExp(
        `^\\[cdp-proxy\\] Auto-reconnect attempt 1/${CHROME_RECONNECT_MAX_ATTEMPTS} failed: Error: ECONNREFUSED`
      )
    );
    expect(failures[1]).toContain(`attempt 2/${CHROME_RECONNECT_MAX_ATTEMPTS} failed`);
    expect(harness.resets).toEqual(['reconnected']);
  });

  it('gives up after the attempt cap and resets the client anyway', async () => {
    const harness = makeHarness({
      discoverChromeWsUrl: async () => {
        throw new Error('no /json/version');
      },
    });

    harness.controller.schedule('close code=1006');
    await harness.controller.settled();

    expect(harness.sleeps).toHaveLength(CHROME_RECONNECT_MAX_ATTEMPTS);
    expect(harness.logs).toContain(
      `[cdp-proxy] Chrome WS reconnect gave up after ${CHROME_RECONNECT_MAX_ATTEMPTS} attempts — resetting client`
    );
    expect(harness.resets).toEqual(['reconnect-failed']);
  });

  it('skips the reset when a new client already rebuilt the Chrome leg', async () => {
    const harness = makeHarness({ isChromeLegHealthy: () => true });
    harness.controller.schedule('close code=1006');
    await harness.controller.settled();

    // A client that connected during the delay has no stale sessions — evicting
    // it would be a pointless reconnect storm.
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.resets).toEqual([]);
    expect(harness.logs).toContain(
      '[cdp-proxy] Chrome WS already re-established — no client reset needed'
    );
  });

  it('does not schedule anything while shutting down', async () => {
    h.shuttingDown.value = true;
    h.controller.schedule('close code=1001');
    await h.controller.settled();

    expect(h.controller.reconnecting).toBe(false);
    expect(h.discover).not.toHaveBeenCalled();
    expect(h.resets).toEqual([]);
    expect(h.logs).toContain(
      '[cdp-proxy] Chrome WS dropped during shutdown — not reconnecting (close code=1001)'
    );
  });

  it('abandons an in-flight loop when shutdown starts mid-delay', async () => {
    const harness = makeHarness();
    harness.controller.schedule('close code=1006');
    harness.shuttingDown.value = true;
    await harness.controller.settled();

    expect(harness.discover).not.toHaveBeenCalled();
    expect(harness.resets).toEqual([]);
    expect(harness.logs).toContain('[cdp-proxy] Chrome WS reconnect cancelled (shutting down)');
  });

  it('cancel() stops the loop without resetting the client', async () => {
    const harness = makeHarness();
    harness.controller.schedule('close code=1006');
    harness.controller.cancel();
    await harness.controller.settled();

    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.resets).toEqual([]);
  });
});

describe('closeClientForUpstreamReset', () => {
  function makeClient(readyState = 1) {
    const closes: { code?: number; reason?: string }[] = [];
    return {
      socket: {
        readyState,
        close: (code?: number, reason?: string) => closes.push({ code, reason }),
      },
      closes,
    };
  }

  it('closes an open client with 4002 upstream-reset', () => {
    const { socket, closes } = makeClient();
    const logs: string[] = [];

    expect(closeClientForUpstreamReset(socket, 'reconnected', (l) => logs.push(l))).toBe(true);
    expect(closes).toEqual([
      { code: CDP_UPSTREAM_RESET_CLOSE_CODE, reason: CDP_UPSTREAM_RESET_CLOSE_REASON },
    ]);
    expect(CDP_UPSTREAM_RESET_CLOSE_CODE).toBe(4002);
    expect(logs).toEqual(['[cdp-proxy] Closing client after Chrome-leg reset (reconnected)']);
  });

  it('is a no-op when there is no client, or it is already closing', () => {
    const logs: string[] = [];
    expect(closeClientForUpstreamReset(null, 'reconnected', (l) => logs.push(l))).toBe(false);

    const { socket, closes } = makeClient(2 /* CLOSING */);
    expect(closeClientForUpstreamReset(socket, 'reconnected', (l) => logs.push(l))).toBe(false);
    expect(closes).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe('markChromeLegDown', () => {
  const socket = { id: 'chrome-1' };

  function makeState(overrides: Partial<ChromeLegState<object>> = {}): ChromeLegState<object> {
    return { chromeWs: socket, messageBuffer: null, shuttingDown: false, ...overrides };
  }

  it('clears the leg and starts buffering client frames', () => {
    const state = makeState();
    expect(markChromeLegDown(state, socket)).toBe(true);
    expect(state.chromeWs).toBeNull();
    // Non-null buffer = forwardClientFrame buffers instead of dropping.
    expect(state.messageBuffer).toEqual([]);
  });

  it('keeps frames already buffered while the leg was down', () => {
    const state = makeState({ chromeWs: null, messageBuffer: ['{"id":1}'] });
    expect(markChromeLegDown(state, socket)).toBe(true);
    expect(state.messageBuffer).toEqual(['{"id":1}']);
  });

  it('ignores a late close from a socket a newer connect replaced', () => {
    const fresh = { id: 'chrome-2' };
    const state = makeState({ chromeWs: fresh });
    expect(markChromeLegDown(state, socket)).toBe(false);
    expect(state.chromeWs).toBe(fresh);
    expect(state.messageBuffer).toBeNull();
  });

  it('does not buffer or reconnect during shutdown', () => {
    const state = makeState({ shuttingDown: true });
    expect(markChromeLegDown(state, socket)).toBe(false);
    expect(state.chromeWs).toBeNull();
    expect(state.messageBuffer).toBeNull();
  });
});
