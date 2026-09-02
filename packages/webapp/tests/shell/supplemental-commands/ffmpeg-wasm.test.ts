/**
 * Lifecycle of the realm-shared `FFmpeg` instance. `getFfmpeg` caches
 * one instance per realm, so the interesting behavior is not loading
 * but *un*loading: a wasm trap poisons the instance, and without
 * `recycleFfmpeg` every later `ffmpeg` in the session re-traps.
 *
 * The heavy core never boots here — `@ffmpeg/ffmpeg` is mocked, so
 * `load()` resolves instantly and `terminate()` is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { instances, loadImpl } = vi.hoisted(() => ({
  instances: [] as Array<{ load: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }>,
  loadImpl: { value: async (): Promise<void> => {} },
}));

vi.mock('@ffmpeg/ffmpeg', () => ({
  FFmpeg: class {
    load = vi.fn(async () => loadImpl.value());
    terminate = vi.fn();
    constructor() {
      instances.push(this as unknown as (typeof instances)[number]);
    }
  },
}));

// The loader refuses to boot under Node; pretend we are in a browser
// realm so `resolveAssetUrls` takes the real ipk path.
vi.mock('../../../src/shell/supplemental-commands/shared.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/shell/supplemental-commands/shared.js')
  >('../../../src/shell/supplemental-commands/shared.js');
  return { ...actual, isNodeRuntime: () => false };
});

import {
  getFfmpeg,
  type IpkResolutionContext,
  recycleFfmpeg,
  resetFfmpegForTests,
} from '../../../src/shell/supplemental-commands/ffmpeg-wasm.js';

/** Fake ipk context with `@ffmpeg/core` installed under /workspace. */
function makeCoreIpk(): IpkResolutionContext {
  const root = '/workspace/node_modules/@ffmpeg/core';
  const sources = new Map<string, string>([
    [`${root}/package.json`, JSON.stringify({ name: '@ffmpeg/core', version: '0.12.10' })],
    [`${root}/dist/esm/ffmpeg-core.js`, '/* core glue */'],
  ]);
  const bytes = new Map<string, Uint8Array>([
    [`${root}/dist/esm/ffmpeg-core.wasm`, new Uint8Array([0x00, 0x61, 0x73, 0x6d])],
  ]);
  const dirs = new Set<string>([
    '/workspace',
    '/workspace/node_modules',
    '/workspace/node_modules/@ffmpeg',
    root,
    `${root}/dist`,
    `${root}/dist/esm`,
  ]);
  return {
    reader: {
      exists: async (path: string) => sources.has(path) || bytes.has(path) || dirs.has(path),
      isDirectory: async (path: string) => dirs.has(path),
      readFile: async (path: string) => {
        const v = sources.get(path);
        if (v === undefined) throw new Error(`ENOENT: ${path}`);
        return v;
      },
    },
    readBytes: async (path: string) => {
      const v = bytes.get(path);
      if (!v) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    fromDir: '/workspace',
  };
}

describe('recycleFfmpeg', () => {
  beforeEach(() => {
    instances.length = 0;
    loadImpl.value = async () => {};
    resetFfmpegForTests();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:core'), revokeObjectURL: vi.fn() });
  });
  afterEach(() => {
    resetFfmpegForTests();
  });

  it('shares one instance across calls until it is recycled', async () => {
    const ipk = makeCoreIpk();
    const first = await getFfmpeg({ ipk });
    expect(await getFfmpeg({ ipk })).toBe(first);
    expect(instances).toHaveLength(1);

    recycleFfmpeg();

    const second = await getFfmpeg({ ipk });
    expect(second).not.toBe(first);
    expect(instances).toHaveLength(2);
  });

  it('terminates the stale worker so the trapped core releases its heap', async () => {
    const ipk = makeCoreIpk();
    await getFfmpeg({ ipk });

    recycleFfmpeg();
    // Termination is scheduled off the settled promise, not inline.
    await Promise.resolve();

    expect(instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing has been loaded', async () => {
    expect(() => recycleFfmpeg()).not.toThrow();
    await Promise.resolve();
    expect(instances).toHaveLength(0);
  });

  it('survives recycling a load that failed, without an unhandled rejection', async () => {
    const ipk = makeCoreIpk();
    loadImpl.value = async () => {
      throw new Error('core boot failed');
    };
    await expect(getFfmpeg({ ipk })).rejects.toThrow('core boot failed');

    // The failed load already cleared the cache, so there is no
    // instance left to terminate — recycling must stay quiet.
    expect(() => recycleFfmpeg()).not.toThrow();
    await Promise.resolve();
    expect(instances[0].terminate).not.toHaveBeenCalled();
  });

  it('tolerates a worker that is already gone', async () => {
    const ipk = makeCoreIpk();
    await getFfmpeg({ ipk });
    instances[0].terminate.mockImplementation(() => {
      throw new Error('worker already terminated');
    });

    recycleFfmpeg();
    await Promise.resolve();

    // Swallowed — and the cache is still cleared for the next call.
    const next = await getFfmpeg({ ipk });
    expect(instances).toHaveLength(2);
    expect(next).toBe(instances[1]);
  });
});
