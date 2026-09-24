/**
 * Unit tests for the realm Request/Response body-read tracker.
 * Installs against a fake global so vitest's own fetch stays untouched.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createBodyReadHandleTracker } from '../../../src/kernel/realm/realm-body-handles.js';
import { attachBufferedBodyReaders } from '../../../src/kernel/realm/realm-fetch-response.js';

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
    class FakeBlob {
      text(): Promise<string> {
        return delayedText();
      }
    }
    class FakeReader {
      read(): Promise<{ done: boolean; value: string }> {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ done: false, value: 'chunk' }), 0);
        });
      }
    }
    class FakeStream {
      pipeTo(): Promise<void> {
        return new Promise((resolve) => {
          setTimeout(() => resolve(), 0);
        });
      }
    }
    const g = {
      Request: FakeRequest,
      Response: FakeResponse,
      Blob: FakeBlob,
      ReadableStream: FakeStream,
      ReadableStreamDefaultReader: FakeReader,
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

  it('counts a constructed Response.text() until it settles', async () => {
    const { g, bodyReads } = installed();
    const pending = new (g.Response as unknown as typeof Response)('hello').text();
    expect(bodyReads.pendingCount).toBe(1);
    await expect(pending).resolves.toBe('from-native');
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

  it('restore puts original prototype methods back', () => {
    const { g, bodyReads } = installed();
    const wrappedText = g.Response.prototype.text;
    bodyReads.restore();
    expect(g.Response.prototype.text).not.toBe(wrappedText);
  });

  it('install and restore are idempotent', () => {
    const { g, bodyReads } = installed();
    const wrappedText = g.Response.prototype.text;
    bodyReads.install();
    expect(g.Response.prototype.text).toBe(wrappedText);
    bodyReads.restore();
    bodyReads.restore();
    expect(g.Response.prototype.text).not.toBe(wrappedText);
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

  it('counts a Blob.text() until it settles', async () => {
    const { g, bodyReads } = installed();
    const pending = new (g.Blob as unknown as typeof Blob)().text();
    expect(bodyReads.pendingCount).toBe(1);
    await pending;
    expect(bodyReads.pendingCount).toBe(0);
  });

  it('counts a ReadableStreamDefaultReader.read() until it settles', async () => {
    const { g, bodyReads } = installed();
    const Reader = (
      g as typeof globalThis & {
        ReadableStreamDefaultReader: new () => { read(): Promise<unknown> };
      }
    ).ReadableStreamDefaultReader;
    const pending = new Reader().read();
    expect(bodyReads.pendingCount).toBe(1);
    await pending;
    expect(bodyReads.pendingCount).toBe(0);
  });

  it('counts ReadableStream.pipeTo until it settles', async () => {
    const { g, bodyReads } = installed();
    const Stream = g.ReadableStream as unknown as new () => { pipeTo(): Promise<void> };
    const pending = new Stream().pipeTo();
    expect(bodyReads.pendingCount).toBe(1);
    await pending;
    expect(bodyReads.pendingCount).toBe(0);
  });

  /** A global with WebAssembly and the realm's VFS mount hook, both async. */
  function withWasmAndMount(): {
    g: typeof globalThis & { __slicc_mountVfs?: () => Promise<string> };
    bodyReads: ReturnType<typeof createBodyReadHandleTracker>;
    originals: { instantiate: unknown; mount: unknown };
  } {
    const later = <T>(value: T): Promise<T> =>
      new Promise((resolve) => {
        setTimeout(() => resolve(value), 0);
      });
    const wasm = {
      instantiate: () => later('instance'),
      compile: () => later('module'),
      validate: () => true,
    };
    const mount = () => later('mounted');
    const g = { WebAssembly: wasm, __slicc_mountVfs: mount } as unknown as typeof globalThis & {
      __slicc_mountVfs?: () => Promise<string>;
    };
    const originals = { instantiate: wasm.instantiate, mount };
    const bodyReads = createBodyReadHandleTracker(g);
    bodyReads.install();
    trackers.push(bodyReads);
    return { g, bodyReads, originals };
  }

  it('counts WebAssembly.instantiate until the module is instantiated', async () => {
    // Emscripten glue starts main only after instantiation; the realm must not
    // drain and exit while it is pending.
    const { g, bodyReads } = withWasmAndMount();
    const pending = (g.WebAssembly.instantiate as unknown as () => Promise<string>)();
    expect(bodyReads.pendingCount).toBe(1);
    await expect(pending).resolves.toBe('instance');
    expect(bodyReads.pendingCount).toBe(0);
    expect(g.WebAssembly.validate(new Uint8Array())).toBe(true);
  });

  it('counts a pending __slicc_mountVfs (an Emscripten --pre-js mounting the VFS)', async () => {
    const { g, bodyReads } = withWasmAndMount();
    const pending = g.__slicc_mountVfs!();
    expect(bodyReads.pendingCount).toBe(1);
    await expect(pending).resolves.toBe('mounted');
    expect(bodyReads.pendingCount).toBe(0);
  });

  it('restore puts WebAssembly back but does not resurrect a hook the realm deleted', () => {
    const { g, bodyReads, originals } = withWasmAndMount();
    delete g.__slicc_mountVfs;
    bodyReads.restore();
    expect(g.WebAssembly.instantiate).toBe(originals.instantiate);
    expect('__slicc_mountVfs' in g).toBe(false);
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
