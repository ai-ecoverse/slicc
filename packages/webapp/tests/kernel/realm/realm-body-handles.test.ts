/**
 * Unit tests for the realm Request/Response body-read tracker.
 * Installs against a fake global so vitest's own fetch stays untouched.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createBodyReadHandleTracker,
  trySyncBodyBytes,
} from '../../../src/kernel/realm/realm-body-handles.js';
import { attachBufferedBodyReaders } from '../../../src/kernel/realm/realm-fetch-response.js';

describe('trySyncBodyBytes', () => {
  it('encodes strings and empty bodies', () => {
    expect(new TextDecoder().decode(trySyncBodyBytes('hello'))).toBe('hello');
    expect(trySyncBodyBytes(null)?.byteLength).toBe(0);
    expect(trySyncBodyBytes(undefined)?.byteLength).toBe(0);
  });

  it('copies typed arrays and ArrayBuffers', () => {
    const view = new Uint8Array([1, 2, 3]);
    expect(Array.from(trySyncBodyBytes(view) ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(trySyncBodyBytes(view.buffer) ?? [])).toEqual([1, 2, 3]);
    expect(trySyncBodyBytes(view)).not.toBe(view);
    const u16 = new Uint16Array([0x0102]);
    expect(trySyncBodyBytes(u16)?.byteLength).toBe(2);
  });

  it('encodes URLSearchParams and leaves streams unconverted', () => {
    const params = trySyncBodyBytes(new URLSearchParams({ a: '1' }));
    expect(new TextDecoder().decode(params)).toBe('a=1');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'));
        c.close();
      },
    });
    expect(trySyncBodyBytes(stream)).toBeUndefined();
  });
});

describe('createBodyReadHandleTracker', () => {
  const trackers: ReturnType<typeof createBodyReadHandleTracker>[] = [];

  afterEach(() => {
    for (const t of trackers) t.restore();
    trackers.length = 0;
  });

  function installed(): {
    g: typeof globalThis;
    bodyReads: ReturnType<typeof createBodyReadHandleTracker>;
  } {
    const delayedText = (): Promise<string> =>
      new Promise((resolve) => {
        setTimeout(() => resolve('from-native'), 0);
      });
    class FakeRequest {
      constructor(
        public readonly input: unknown,
        public readonly init?: RequestInit
      ) {}
      text(): Promise<string> {
        return delayedText();
      }
      formData(): string {
        return 'not-thenable';
      }
    }
    class FakeResponse {
      constructor(
        public readonly bodyInit?: BodyInit | null,
        public readonly init?: ResponseInit
      ) {}
      text(): Promise<string> {
        return delayedText();
      }
      get blob(): unknown {
        return undefined;
      }
    }
    const g = {
      Request: FakeRequest,
      Response: FakeResponse,
    } as unknown as typeof globalThis;
    const bodyReads = createBodyReadHandleTracker(g);
    bodyReads.install();
    trackers.push(bodyReads);
    return { g, bodyReads };
  }

  it('counts a native stream body read until it settles', async () => {
    const { g, bodyReads } = installed();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'));
        c.close();
      },
    });
    const pending = new (g.Response as unknown as typeof Response)(stream).text();
    expect(bodyReads.pendingCount).toBe(1);
    await pending;
    expect(bodyReads.pendingCount).toBe(0);
  });

  it('does not count a sync-bufferable constructed Response as a handle', async () => {
    const { g, bodyReads } = installed();
    const res = new (g.Response as unknown as typeof Response)('hello');
    expect(bodyReads.pendingCount).toBe(0);
    await expect(res.text()).resolves.toBe('hello');
    expect(bodyReads.pendingCount).toBe(0);
  });

  it('waitForProgress resolves when the tracked read settles', async () => {
    const { g, bodyReads } = installed();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'));
        c.close();
      },
    });
    const pending = new (g.Response as unknown as typeof Response)(stream).text();
    const progressed = bodyReads.waitForProgress();
    await pending;
    await progressed;
    expect(bodyReads.pendingCount).toBe(0);
  });

  it('restore puts the original constructors back', () => {
    const { g, bodyReads } = installed();
    const wrapped = g.Response;
    bodyReads.restore();
    expect(g.Response).not.toBe(wrapped);
  });

  it('install and restore are idempotent', () => {
    const { g, bodyReads } = installed();
    const wrapped = g.Response;
    bodyReads.install();
    expect(g.Response).toBe(wrapped);
    bodyReads.restore();
    bodyReads.restore();
    expect(g.Response).not.toBe(wrapped);
  });

  it('waitForProgress resolves immediately when nothing is pending', async () => {
    const { bodyReads } = installed();
    await bodyReads.waitForProgress();
    expect(bodyReads.pendingCount).toBe(0);
  });

  it('does not count a non-thenable body method', () => {
    const { g, bodyReads } = installed();
    const req = new (g.Request as unknown as typeof Request)('https://example.test/');
    expect((req as unknown as { formData: () => string }).formData()).toBe('not-thenable');
    expect(bodyReads.pendingCount).toBe(0);
  });

  it('skips wrapping when Request and Response are missing', () => {
    const g = {} as typeof globalThis;
    const bodyReads = createBodyReadHandleTracker(g);
    bodyReads.install();
    trackers.push(bodyReads);
    expect(bodyReads.pendingCount).toBe(0);
    bodyReads.restore();
  });
});

describe('attachBufferedBodyReaders', () => {
  it('is idempotent so a second attach does not reset bodyUsed', async () => {
    const res = new Response('first');
    const bytes = new TextEncoder().encode('first');
    attachBufferedBodyReaders(res, bytes);
    await expect(res.text()).resolves.toBe('first');
    attachBufferedBodyReaders(res, bytes);
    await expect(res.text()).rejects.toThrow(/already used/);
  });
});
