import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/index.js';
import {
  CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS,
  connectWithBoundedRetry,
} from '../../../src/ui/boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';

function createLog(): BootStageLogger & {
  warnCalls: unknown[][];
  infoCalls: unknown[][];
} {
  const warnCalls: unknown[][] = [];
  const infoCalls: unknown[][] = [];
  return {
    debug: vi.fn(),
    info: (..._args: unknown[]) => {
      infoCalls.push(_args);
    },
    warn: (..._args: unknown[]) => {
      warnCalls.push(_args);
    },
    error: vi.fn(),
    warnCalls,
    infoCalls,
  } as unknown as BootStageLogger & { warnCalls: unknown[][]; infoCalls: unknown[][] };
}

function createBrowser(connect: BrowserAPI['connect']): BrowserAPI {
  return { connect } as unknown as BrowserAPI;
}

describe('connectWithBoundedRetry', () => {
  it('resolves on the first attempt when the bridge accepts immediately', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const log = createLog();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await connectWithBoundedRetry(
      createBrowser(connect as unknown as BrowserAPI['connect']),
      { url: 'ws://localhost:5710/cdp', protocols: 'slicc.bridge.v1.x' },
      log,
      [100, 200],
      sleep
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.warnCalls).toHaveLength(0);
    expect(log.infoCalls).toHaveLength(0);
  });

  it('retries with the supplied backoff schedule and succeeds after a transient failure', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);
    const log = createLog();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await connectWithBoundedRetry(
      createBrowser(connect as unknown as BrowserAPI['connect']),
      undefined,
      log,
      [100, 200, 400],
      sleep
    );

    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
    expect(log.infoCalls).toHaveLength(1);
    expect(log.warnCalls).toHaveLength(0);
  });

  it('gives up after all retries are exhausted and logs the final failure (does not throw)', async () => {
    const err = new Error('bridge never came up');
    const connect = vi.fn().mockRejectedValue(err);
    const log = createLog();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await connectWithBoundedRetry(
      createBrowser(connect as unknown as BrowserAPI['connect']),
      undefined,
      log,
      [50, 50],
      sleep
    );

    // delays.length + 1 attempts total.
    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log.warnCalls).toHaveLength(1);
    expect(String(log.warnCalls[0]?.[1] ?? '')).toBe('bridge never came up');
  });

  it('exposes a non-trivial default backoff schedule', () => {
    expect(CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    // Schedule must be monotonically non-decreasing — exponential backoff intent.
    for (let i = 1; i < CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS.length; i++) {
      const prev = CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS[i - 1] ?? 0;
      const cur = CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS[i] ?? 0;
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });
});
