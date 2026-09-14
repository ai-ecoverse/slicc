import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHROME_RECONNECT_DELAY_MS,
  CHROME_RECONNECT_FAILURE_THRESHOLD,
  type ChromeLegState,
  ChromeReconnectController,
  type ChromeReconnectDeps,
  closeClientForUpstreamReset,
  markChromeLegDown,
} from '../../src/cdp-proxy/chrome-reconnect.js';
import { createClientFrameBuffer } from '../../src/cdp-proxy/client-frame-buffer.js';
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

  activeClient: { id: number | null };
}

function makeHarness(overrides: Partial<ChromeReconnectDeps> = {}): Harness {
  const logs: string[] = [];
  const resets: string[] = [];
  const sleeps: number[] = [];
  const shuttingDown = { value: false };
  const activeClient: { id: number | null } = { id: 1 };
  const discover = vi.fn(async () => 'ws://127.0.0.1:9222/devtools/browser/fresh');
  const connect = vi.fn(async () => {});

  const controller = new ChromeReconnectController({
    discoverChromeWsUrl: discover,
    connectChrome: connect,
    resetClient: (reason) => resets.push(reason),
    activeClientId: () => activeClient.id,
    isShuttingDown: () => shuttingDown.value,
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });

  return { controller, logs, resets, discover, connect, sleeps, shuttingDown, activeClient };
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

  it('resets the slot holder that saw the dead leg once the Chrome leg is back', async () => {
    h.controller.schedule('close code=1009');
    await h.controller.settled();

    expect(h.resets).toEqual(['reconnected']);
  });

  it('leaves a client that connected during the outage connected', async () => {
    const harness = makeHarness();
    harness.activeClient.id = 7;
    harness.controller.schedule('close code=1006');

    harness.activeClient.id = 8;
    await harness.controller.settled();

    expect(harness.resets).toEqual([]);
    expect(harness.logs).toContain(
      '[cdp-proxy] Client connected during the outage — no stale sessions, not resetting it'
    );
  });

  it('resets nobody when a replacement arrives after the third-failure reset', async () => {
    const resets: string[] = [];
    const slot: { id: number | null } = { id: 4 };
    let calls = 0;
    const harness = makeHarness({
      connectChrome: async () => {
        calls++;
        if (calls <= 3) throw new Error('ECONNREFUSED');
      },
      activeClientId: () => slot.id,
      resetClient: (reason) => {
        resets.push(reason);

        if (reason === 'reconnect-failed') slot.id = 5;
      },
    });

    harness.controller.schedule('close code=1006');
    await harness.controller.settled();

    expect(resets).toEqual(['reconnect-failed']);
    expect(calls).toBe(4);
  });

  it('re-samples the slot holder when the leg drops again mid-loop', async () => {
    const harness = makeHarness();
    harness.activeClient.id = 1;
    harness.controller.schedule('close code=1006');
    harness.activeClient.id = 2;
    harness.controller.schedule('close code=1006');
    await harness.controller.settled();

    expect(harness.resets).toEqual(['reconnected']);
  });

  it('does not reset when the slot is empty at both the drop and the reconnect', async () => {
    const harness = makeHarness();
    harness.activeClient.id = null;
    harness.controller.schedule('close code=1006');
    await harness.controller.settled();

    expect(harness.resets).toEqual([]);
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
      /^\[cdp-proxy\] Auto-reconnect attempt 1 failed: Error: ECONNREFUSED/
    );
    expect(failures[1]).toContain('attempt 2 failed');

    expect(harness.resets).toEqual(['reconnected']);
  });

  it('resets the client after the 3rd consecutive failure and keeps retrying', async () => {
    let calls = 0;
    const harness = makeHarness({
      connectChrome: async () => {
        calls++;
        if (calls <= 5) throw new Error('ECONNREFUSED');
      },
    });

    harness.controller.schedule('close code=1006');
    await harness.controller.settled();

    expect(CHROME_RECONNECT_FAILURE_THRESHOLD).toBe(3);
    expect(harness.logs).toContain(
      '[cdp-proxy] Chrome WS reconnect failed 3x — resetting client (still retrying)'
    );

    expect(calls).toBe(6);

    expect(harness.resets).toEqual(['reconnect-failed', 'reconnected']);
  });

  it('never gives up — no attempt cap, only shutdown stops the loop', async () => {
    const attemptsBeforeCancel = 25;
    let attempts = 0;
    const harness = makeHarness({
      discoverChromeWsUrl: async () => {
        attempts++;
        throw new Error('no /json/version');
      },
    });
    harness.controller.schedule('close code=1006');

    for (let i = 0; i < 2000 && attempts < attemptsBeforeCancel; i++) {
      await Promise.resolve();
    }
    harness.controller.cancel();
    await harness.controller.settled();

    expect(attempts).toBeGreaterThanOrEqual(attemptsBeforeCancel);
    expect(harness.sleeps.length).toBeGreaterThanOrEqual(attemptsBeforeCancel);

    expect(harness.resets).toEqual(['reconnect-failed']);
    expect(harness.logs.some((l) => l.includes('gave up'))).toBe(false);
  });

  it('skips the reset when a new client already rebuilt the Chrome leg', async () => {
    const harness = makeHarness({ isChromeLegHealthy: () => true });
    harness.controller.schedule('close code=1006');
    await harness.controller.settled();

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

    const { socket, closes } = makeClient(2);
    expect(closeClientForUpstreamReset(socket, 'reconnected', (l) => logs.push(l))).toBe(false);
    expect(closes).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe('markChromeLegDown', () => {
  const socket = { id: 'chrome-1' };

  function makeState(overrides: Partial<ChromeLegState<object>> = {}): ChromeLegState<object> {
    return {
      chromeWs: socket,
      chromeConnectionId: 7,
      activeClientId: 3,
      messageBuffer: null,
      shuttingDown: false,
      ...overrides,
    };
  }

  it('clears the leg and starts buffering client frames', () => {
    const state = makeState();
    expect(markChromeLegDown(state, socket)).toBe(true);
    expect(state.chromeWs).toBeNull();

    expect(state.messageBuffer).toEqual({
      generation: { chromeConnectionId: 7, clientId: 3 },
      frames: [],
    });
  });

  it('keeps frames already buffered while the leg was down', () => {
    const existing = createClientFrameBuffer({ chromeConnectionId: null, clientId: 3 });
    existing.frames.push('{"id":1}');
    const state = makeState({ chromeWs: null, messageBuffer: existing });
    expect(markChromeLegDown(state, socket)).toBe(true);

    expect(state.messageBuffer).toBe(existing);
    expect(state.messageBuffer?.frames).toEqual(['{"id":1}']);
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
