import 'fake-indexeddb/auto';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import type { StreamingFetch } from '../../../src/shell/proxied-fetch.js';
import {
  DEFAULT_HF_CONCURRENCY,
  downloadHfRepo,
  HF_INCOMPLETE_SUFFIX,
  HF_STREAM_WRITE_BYTES,
  HfFileDownloadError,
  type HfFileEvent,
} from '../../../src/shell/supplemental-commands/hf-download.js';

type SecureFetchOptions = NonNullable<Parameters<SecureFetch>[1]>;

type FetchResult = Awaited<ReturnType<SecureFetch>>;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-hf-download-${dbCounter++}`, wipe: true });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeFetch(files: Record<string, Uint8Array>, recorder?: { calls: string[] }): SecureFetch {
  return (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    recorder?.calls.push(url);
    if (url.includes('/api/models/')) {
      const entries = Object.entries(files).map(([path, b]) => ({
        type: 'file',
        path,
        size: b.byteLength,
      }));
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: bytes(JSON.stringify(entries)),
        url,
      };
    }
    const m = url.match(/\/resolve\/[^/]+\/(.+)$/);
    const body = m ? files[m[1]] : undefined;
    if (!body) return { status: 404, statusText: 'Not Found', headers: {}, body: bytes(''), url };
    return { status: 200, statusText: 'OK', headers: {}, body, url };
  }) as unknown as SecureFetch;
}

describe('downloadHfRepo', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await newFs();
  });

  it('lists the tree then downloads every file, streaming progress', async () => {
    const fetch = makeFetch({ 'config.json': bytes('{}'), 'model.bin': bytes('abcd') });
    const listed: Array<{ files: string[]; totalBytes: number }> = [];
    const events: HfFileEvent[] = [];
    const result = await downloadHfRepo({
      fetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      progress: { onListed: (i) => listed.push(i), onFile: (e) => events.push(e) },
    });
    expect(listed).toEqual([{ files: ['config.json', 'model.bin'], totalBytes: 6 }]);
    expect(events.map((e) => [e.file, e.status, e.index, e.total])).toEqual([
      ['config.json', 'downloaded', 1, 2],
      ['model.bin', 'downloaded', 2, 2],
    ]);
    expect(result).toMatchObject({ downloaded: 2, skipped: 0, totalBytes: 6 });
    expect(await fs.exists('/m/config.json')).toBe(true);
    expect(await fs.exists('/m/model.bin')).toBe(true);
  });

  it('does not list the whole tree when an explicit file set is provided', async () => {
    const recorder = { calls: [] as string[] };
    const fetch = makeFetch({ 'a.txt': bytes('A'), 'b.txt': bytes('B') }, recorder);
    const listed: unknown[] = [];
    const result = await downloadHfRepo({
      fetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      files: ['a.txt'],
      progress: { onListed: (i) => listed.push(i) },
    });
    expect(listed).toEqual([]);

    expect(recorder.calls.filter((c) => c.includes('/api/models/'))).toEqual([
      'https://huggingface.co/api/models/owner/name/tree/main',
    ]);
    expect(result.downloaded).toBe(1);
    expect(await fs.exists('/m/b.txt')).toBe(false);
  });

  it('skips files already present at the listed byte length unless force is set', async () => {
    const fetch = makeFetch({ 'a.txt': bytes('A') });
    await fs.mkdir('/m', { recursive: true });

    await fs.writeFile('/m/a.txt', bytes('P'));
    const skip = await downloadHfRepo({ fetch, fs, repo: 'owner/name', targetDir: '/m' });
    expect(skip).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(await fs.readFile('/m/a.txt')).toBe('P');
    const forced = await downloadHfRepo({
      fetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      force: true,
    });
    expect(forced).toMatchObject({ downloaded: 1, skipped: 0 });
    expect(await fs.readFile('/m/a.txt')).toBe('A');
  });

  it('throws HfFileDownloadError naming the file on a per-file failure', async () => {
    const failingResolve: SecureFetch = (async (url: string): Promise<FetchResult> => {
      if (url.includes('/resolve/')) throw new TypeError('Failed to fetch');
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: bytes(JSON.stringify([{ type: 'file', path: 'a.txt', size: 1 }])),
        url,
      };
    }) as unknown as SecureFetch;
    await expect(
      downloadHfRepo({ fetch: failingResolve, fs, repo: 'owner/name', targetDir: '/m' })
    ).rejects.toMatchObject({ name: 'HfFileDownloadError', file: 'a.txt' });
  });

  it('throws a plain error on a list failure and on an empty repo', async () => {
    const notFound: SecureFetch = (async (url: string): Promise<FetchResult> => ({
      status: 404,
      statusText: 'Not Found',
      headers: {},
      body: bytes(''),
      url,
    })) as unknown as SecureFetch;
    await expect(
      downloadHfRepo({ fetch: notFound, fs, repo: 'owner/x', targetDir: '/m' })
    ).rejects.toThrow(/HF API 404/);
    const empty = makeFetch({});
    const err = await downloadHfRepo({ fetch: empty, fs, repo: 'owner/x', targetDir: '/m' }).catch(
      (e) => e
    );
    expect(err).not.toBeInstanceOf(HfFileDownloadError);
    expect(String(err)).toMatch(/has no files/);
  });

  it('re-downloads a present file whose size differs from the listing (torn write)', async () => {
    const fetch = makeFetch({ 'model.onnx': bytes('COMPLETE') });
    await fs.mkdir('/m', { recursive: true });
    await fs.writeFile('/m/model.onnx', bytes('COMP'));
    const events: HfFileEvent[] = [];
    const r = await downloadHfRepo({
      fetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      progress: { onFile: (e) => events.push(e) },
    });
    expect(r).toMatchObject({ downloaded: 1, skipped: 0 });
    expect(await fs.readFile('/m/model.onnx')).toBe('COMPLETE');
    expect(events[0]).toMatchObject({ file: 'model.onnx', status: 'downloaded', bytes: 8 });
  });

  it('re-fetches a short file from an explicit list once its directory listing sizes it', async () => {
    const recorder = { calls: [] as string[] };
    const fetch = makeFetch({ 'sub/a.bin': bytes('FULL'), 'sub/b.bin': bytes('BB') }, recorder);
    await fs.mkdir('/m/sub', { recursive: true });
    await fs.writeFile('/m/sub/a.bin', bytes('FU'));
    await fs.writeFile('/m/sub/b.bin', bytes('bb'));
    const r = await downloadHfRepo({
      fetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      files: ['sub/a.bin', 'sub/b.bin'],
    });
    expect(r).toMatchObject({ downloaded: 1, skipped: 1 });
    expect(await fs.readFile('/m/sub/a.bin')).toBe('FULL');
    expect(recorder.calls).toContain('https://huggingface.co/api/models/owner/name/tree/main/sub');
  });

  it('keeps presence-only skipping for an explicit file list when sizes are unavailable', async () => {
    const inner = makeFetch({ 'a.txt': bytes('A') });
    const fetch = (async (url: string, opts?: SecureFetchOptions): Promise<FetchResult> => {
      if (url.includes('/api/models/')) {
        return { status: 500, statusText: 'Server Error', headers: {}, body: bytes(''), url };
      }
      return inner(url, opts);
    }) as unknown as SecureFetch;
    await fs.mkdir('/m', { recursive: true });
    await fs.writeFile('/m/a.txt', bytes('PRE'));
    const r = await downloadHfRepo({
      fetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      files: ['a.txt'],
    });
    expect(r).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(await fs.readFile('/m/a.txt')).toBe('PRE');
  });
});

function gatedFetch(sizes: Record<string, number>, opts: { list?: boolean } = {}) {
  const list = opts.list ?? true;
  const pending = new Map<
    string,
    { resolve: (r: FetchResult) => void; reject: (e: unknown) => void; url: string }
  >();
  const state = { active: 0, maxActive: 0, started: [] as string[], aborted: [] as string[] };
  const fetch = (async (url: string, init?: SecureFetchOptions): Promise<FetchResult> => {
    if (url.includes('/api/models/')) {
      if (!list) throw new Error('unexpected listing');
      const entries = Object.entries(sizes).map(([path, size]) => ({ type: 'file', path, size }));
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: bytes(JSON.stringify(entries)),
        url,
      };
    }
    const file = url.match(/\/resolve\/[^/]+\/(.+)$/)?.[1] ?? url;
    state.started.push(file);
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      return await new Promise<FetchResult>((resolve, reject) => {
        pending.set(file, { resolve, reject, url });
        init?.signal?.addEventListener('abort', () => {
          if (!pending.has(file)) return;
          state.aborted.push(file);
          reject(new Error('The operation was aborted'));
        });
      });
    } finally {
      state.active -= 1;
      pending.delete(file);
    }
  }) as unknown as SecureFetch;
  const release = (file: string) => {
    const p = pending.get(file);
    if (!p) throw new Error(`${file} is not in flight`);
    p.resolve({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: new Uint8Array(sizes[file]),
      url: p.url,
    });
  };
  const fail = (file: string, status = 500) => {
    const p = pending.get(file);
    if (!p) throw new Error(`${file} is not in flight`);
    p.resolve({ status, statusText: 'Server Error', headers: {}, body: bytes(''), url: p.url });
  };
  const inFlight = () => [...pending.keys()];
  return { fetch, state, release, fail, inFlight };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('downloadHfRepo download pool', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await newFs();
  });

  const shards = (n: number, size: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`shard_${i}`, size]));

  it('downloads several files at once, never more than the concurrency limit', async () => {
    const g = gatedFetch(shards(6, 10));
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      concurrency: 3,
    });
    await waitFor(() => g.inFlight().length === 3, 'three downloads in flight');

    g.release('shard_0');
    await waitFor(() => g.state.started.length === 4, 'a fourth download');
    for (const f of ['shard_1', 'shard_2', 'shard_3']) g.release(f);
    await waitFor(() => g.inFlight().length === 2, 'the last two downloads');
    for (const f of g.inFlight()) g.release(f);
    const r = await run;
    expect(g.state.maxActive).toBe(3);
    expect(r).toMatchObject({ downloaded: 6, skipped: 0, totalBytes: 60 });
  });

  it('defaults to more than one download at a time', async () => {
    const g = gatedFetch(shards(8, 10));
    const run = downloadHfRepo({ fetch: g.fetch, fs, repo: 'o/n', targetDir: '/m' });
    await waitFor(() => g.inFlight().length === DEFAULT_HF_CONCURRENCY, 'default pool size');
    while (g.state.started.length < 8 || g.inFlight().length > 0) {
      await waitFor(() => g.inFlight().length > 0, 'next download');
      for (const f of g.inFlight()) g.release(f);
      await new Promise((r) => setTimeout(r, 1));
    }
    await run;
    expect(DEFAULT_HF_CONCURRENCY).toBeGreaterThan(1);
    expect(g.state.maxActive).toBe(DEFAULT_HF_CONCURRENCY);
  });

  it('admits downloads only while their declared bytes fit the in-flight budget', async () => {
    const g = gatedFetch({ big: 70, small1: 20, small2: 20, small3: 20 });
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      concurrency: 4,
      maxBytesInFlight: 100,
    });

    await waitFor(() => g.inFlight().length === 2, 'big + one small');
    await new Promise((r) => setTimeout(r, 10));
    expect(g.inFlight().sort()).toEqual(['big', 'small1']);
    g.release('big');
    await waitFor(() => g.inFlight().length === 3, 'the remaining smalls');
    for (const f of g.inFlight()) g.release(f);
    await run;
    expect(g.state.maxActive).toBe(3);
  });

  it('still downloads a file larger than the whole budget, on its own', async () => {
    const g = gatedFetch({ huge: 500, tiny: 1 });
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      maxBytesInFlight: 100,
    });
    await waitFor(() => g.inFlight().length === 1, 'huge alone');
    await new Promise((r) => setTimeout(r, 10));
    expect(g.inFlight()).toEqual(['huge']);
    g.release('huge');
    await waitFor(() => g.inFlight().length === 1 && g.inFlight()[0] === 'tiny', 'tiny');
    g.release('tiny');
    await expect(run).resolves.toMatchObject({ downloaded: 2 });
  });

  it('sizes an explicit file list from its directory listing and pools it', async () => {
    const g = gatedFetch(shards(4, 30));
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      files: Object.keys(shards(4, 30)),
      maxBytesInFlight: 100,
    });

    await waitFor(() => g.inFlight().length === 3, 'three sized files');
    await new Promise((r) => setTimeout(r, 10));
    expect(g.inFlight()).toHaveLength(3);
    for (const f of g.inFlight()) g.release(f);
    await waitFor(() => g.inFlight().length === 1, 'the fourth');
    g.release(g.inFlight()[0]);
    await expect(run).resolves.toMatchObject({ downloaded: 4 });
  });

  it('charges each unsized file the whole budget, even after small files finish', async () => {
    const g = gatedFetch({ 'config.json': 1, big_0: 90, big_1: 90 }, { list: false });
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      files: ['config.json', 'big_0', 'big_1'],
      maxBytesInFlight: 100,
    });
    for (const f of ['config.json', 'big_0', 'big_1']) {
      await waitFor(() => g.inFlight().length === 1, f);
      await new Promise((r) => setTimeout(r, 10));
      expect(g.inFlight()).toEqual([f]);
      g.release(f);
    }
    await expect(run).resolves.toMatchObject({ downloaded: 3 });
    expect(g.state.maxActive).toBe(1);
  });

  it('aborts a slow tree listing when the caller cancels', async () => {
    const controller = new AbortController();
    const fetch = ((_url: string, init?: SecureFetchOptions): Promise<FetchResult> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as SecureFetch;
    const run = downloadHfRepo({
      fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      signal: controller.signal,
    }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect(String(await run)).toMatch(/download aborted/);
  });

  it('stops before downloading when cancelled during the size lookup', async () => {
    const controller = new AbortController();
    const g = gatedFetch({ a: 1 });
    const fetch = (async (url: string, init?: SecureFetchOptions) => {
      if (url.includes('/api/models/')) controller.abort();
      return g.fetch(url, init);
    }) as unknown as SecureFetch;
    const err = await downloadHfRepo({
      fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      files: ['a'],
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/download aborted/);
    expect(g.state.started).toEqual([]);
  });

  it('reports every file whatever order they finish in', async () => {
    const g = gatedFetch({ a: 1, b: 2, c: 3 });
    const events: HfFileEvent[] = [];
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      progress: { onFile: (e) => events.push(e) },
    });
    await waitFor(() => g.inFlight().length === 3, 'all three');
    g.release('c');
    await waitFor(() => events.length === 1, 'c done');
    g.release('a');
    await waitFor(() => events.length === 2, 'a done');
    g.release('b');
    const r = await run;
    expect(events.map((e) => [e.file, e.index, e.total])).toEqual([
      ['c', 1, 3],
      ['a', 2, 3],
      ['b', 3, 3],
    ]);
    expect(r).toMatchObject({ files: ['a', 'b', 'c'], downloaded: 3, totalBytes: 6 });
    for (const [f, size] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const) {
      expect((await fs.stat(`/m/${f}`)).size).toBe(size);
    }
  });

  it('names the failing file, aborts the downloads in flight and starts no more', async () => {
    const g = gatedFetch(shards(8, 10));
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      concurrency: 3,
    });
    const settled = run.then(
      () => null,
      (e: unknown) => e
    );
    await waitFor(() => g.inFlight().length === 3, 'three in flight');
    g.fail('shard_1');
    const err = await settled;
    expect(err).toBeInstanceOf(HfFileDownloadError);
    expect(err).toMatchObject({ file: 'shard_1', message: expect.stringMatching(/HTTP 500/) });
    expect(g.state.aborted.sort()).toEqual(['shard_0', 'shard_2']);
    expect(g.state.started).toHaveLength(3);
    expect(g.inFlight()).toEqual([]);
    expect(await fs.exists('/m/shard_0')).toBe(false);
  });

  it('does not write a body that arrives after another file failed', async () => {
    let finishLate: (() => void) | undefined;
    const fetch = (async (url: string): Promise<FetchResult> => {
      if (url.includes('/api/models/')) {
        const entries = [
          { type: 'file', path: 'slow', size: 1 },
          { type: 'file', path: 'bad', size: 1 },
        ];
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: bytes(JSON.stringify(entries)),
          url,
        };
      }
      if (url.endsWith('/bad')) {
        return { status: 404, statusText: 'Not Found', headers: {}, body: bytes(''), url };
      }
      await new Promise<void>((r) => {
        finishLate = r;
      });
      return { status: 200, statusText: 'OK', headers: {}, body: bytes('S'), url };
    }) as unknown as SecureFetch;
    const run = downloadHfRepo({ fetch, fs, repo: 'o/n', targetDir: '/m' }).catch((e) => e);
    await waitFor(() => finishLate !== undefined, 'slow in flight');
    await new Promise((r) => setTimeout(r, 5));
    finishLate?.();
    expect(await run).toMatchObject({ name: 'HfFileDownloadError', file: 'bad' });
    expect(await fs.exists('/m/slow')).toBe(false);
  });

  it('skips complete files and re-fetches short ones while pooling', async () => {
    const g = gatedFetch({ done1: 4, done2: 4, short: 4, missing: 4 });
    await fs.mkdir('/m', { recursive: true });
    await fs.writeFile('/m/done1', bytes('AAAA'));
    await fs.writeFile('/m/done2', bytes('BBBB'));
    await fs.writeFile('/m/short', bytes('CC'));
    const events: HfFileEvent[] = [];
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      progress: { onFile: (e) => events.push(e) },
    });
    await waitFor(() => g.inFlight().length === 2, 'short + missing');
    expect(g.inFlight().sort()).toEqual(['missing', 'short']);
    for (const f of g.inFlight()) g.release(f);
    const r = await run;
    expect(r).toMatchObject({ downloaded: 2, skipped: 2, totalBytes: 16 });
    expect(g.state.started.sort()).toEqual(['missing', 'short']);
    expect(await fs.readFile('/m/done1')).toBe('AAAA');
    expect((await fs.stat('/m/short')).size).toBe(4);
    expect(
      events
        .filter((e) => e.status === 'skipped')
        .map((e) => e.file)
        .sort()
    ).toEqual(['done1', 'done2']);
  });

  it('cancels in-flight downloads when the caller aborts', async () => {
    const g = gatedFetch(shards(3, 10));
    const controller = new AbortController();
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      signal: controller.signal,
    }).catch((e) => e);
    await waitFor(() => g.inFlight().length === 3, 'all in flight');
    controller.abort();
    const err = await run;
    expect(err).not.toBeInstanceOf(HfFileDownloadError);
    expect(String(err)).toMatch(/aborted/);
    expect(g.state.aborted.sort()).toEqual(['shard_0', 'shard_1', 'shard_2']);
  });

  it('creates a shared nested parent directory safely from parallel writes', async () => {
    const names = ['kev/r-1/q8/d_0', 'kev/r-1/q8/d_1', 'kev/r-1/q8/d_2', 'kev/r-1/q8/d_3'];
    const g = gatedFetch(Object.fromEntries(names.map((n) => [n, 5])));
    const run = downloadHfRepo({ fetch: g.fetch, fs, repo: 'o/n', targetDir: '/m' });
    await waitFor(() => g.inFlight().length === 4, 'all four in flight');
    for (const f of g.inFlight()) g.release(f);
    await expect(run).resolves.toMatchObject({ downloaded: 4 });
    for (const n of names) expect((await fs.stat(`/m/${n}`)).size).toBe(5);
  });

  it('treats a non-positive concurrency or budget as the default', async () => {
    const g = gatedFetch(shards(2, 10));
    const run = downloadHfRepo({
      fetch: g.fetch,
      fs,
      repo: 'o/n',
      targetDir: '/m',
      concurrency: 0,
      maxBytesInFlight: -1,
    });
    await waitFor(() => g.inFlight().length === 2, 'both in flight');
    for (const f of g.inFlight()) g.release(f);
    await expect(run).resolves.toMatchObject({ downloaded: 2 });
  });
});

function makeStreamFetch(
  files: Record<string, Uint8Array>,
  opts: { chunk?: number; dieAfter?: number; contentLength?: number } = {}
): { fetch: StreamingFetch; cancelled: string[] } {
  const cancelled: string[] = [];
  const fetch: StreamingFetch = async (url) => {
    const m = url.match(/\/resolve\/[^/]+\/(.+)$/);
    const body = m ? files[m[1]] : undefined;
    const chunk = opts.chunk ?? 3;
    async function* gen(): AsyncGenerator<Uint8Array> {
      for (let at = 0; body && at < body.byteLength; at += chunk) {
        if (opts.dieAfter !== undefined && at >= opts.dieAfter) {
          throw new TypeError('network error');
        }
        yield body.slice(at, at + chunk);
      }
    }
    return {
      status: body ? 200 : 404,
      statusText: body ? 'OK' : 'Not Found',
      headers: {},
      url,
      contentLength: body ? (opts.contentLength ?? body.byteLength) : undefined,
      body: gen(),
      cancel: async () => {
        cancelled.push(url);
      },
    };
  };
  return { fetch, cancelled };
}

describe('downloadHfRepo streamed path (#3441)', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await newFs();
  });

  it('writes the body in bounded pieces and never buffers the whole file', async () => {
    const size = HF_STREAM_WRITE_BYTES * 2 + 5;
    const big = new Uint8Array(size);
    for (let i = 0; i < size; i += 997) big[i] = i & 0xff;
    const { fetch: streamFetch } = makeStreamFetch({ 'model.bin': big }, { chunk: 1 << 20 });
    const buffered = makeFetch({});
    const appended: number[] = [];
    const appendFile = fs.appendFile.bind(fs);
    fs.appendFile = async (path, data) => {
      if (path === '/m/model.bin') appended.push((data as Uint8Array).byteLength);
      return appendFile(path, data);
    };
    const r = await downloadHfRepo({
      fetch: buffered,
      streamFetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      files: ['model.bin'],
    });
    expect(r).toMatchObject({ downloaded: 1, totalBytes: size });
    expect(appended).toEqual([HF_STREAM_WRITE_BYTES, HF_STREAM_WRITE_BYTES, 5]);
    const back = (await fs.readFile('/m/model.bin', { encoding: 'binary' })) as Uint8Array;
    expect(back.byteLength).toBe(size);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(big))).toBe(0);
    expect(await fs.exists(`/m/model.bin${HF_INCOMPLETE_SUFFIX}`)).toBe(false);
  });

  it('charges a streamed file one write piece, so large files share the budget', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const streamFetch: StreamingFetch = async (url) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      async function* body(): AsyncGenerator<Uint8Array> {
        yield bytes('x');
        active -= 1;
      }
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        url,
        contentLength: 1,
        body: body(),
        cancel: async () => undefined,
      };
    };
    const run = downloadHfRepo({
      fetch: makeFetch({}),
      streamFetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      files: ['a.bin', 'b.bin', 'c.bin'],
      concurrency: 3,
      maxBytesInFlight: 3 * HF_STREAM_WRITE_BYTES,
    });
    await waitFor(() => release.length === 3, 'three streams in flight');
    for (const r of release) r();
    await expect(run).resolves.toMatchObject({ downloaded: 3 });
    expect(peak).toBe(3);
  });

  it('leaves an incomplete marker when the transfer dies, and re-fetches on the next run', async () => {
    const files = { 'a.bin': bytes('0123456789') };
    const dying = makeStreamFetch(files, { dieAfter: 6 });
    await expect(
      downloadHfRepo({
        fetch: makeFetch({}),
        streamFetch: dying.fetch,
        fs,
        repo: 'owner/name',
        targetDir: '/m',
        files: ['a.bin'],
      })
    ).rejects.toMatchObject({ name: 'HfFileDownloadError', file: 'a.bin' });

    expect(await fs.exists(`/m/a.bin${HF_INCOMPLETE_SUFFIX}`)).toBe(true);

    const r = await downloadHfRepo({
      fetch: makeFetch({}),
      streamFetch: makeStreamFetch(files).fetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      files: ['a.bin'],
    });
    expect(r).toMatchObject({ downloaded: 1, skipped: 0 });
    expect(await fs.readFile('/m/a.bin')).toBe('0123456789');
    expect(await fs.exists(`/m/a.bin${HF_INCOMPLETE_SUFFIX}`)).toBe(false);
  });

  it('fails a body shorter than its declared length', async () => {
    const { fetch: streamFetch } = makeStreamFetch(
      { 'a.bin': bytes('abc') },
      { contentLength: 10 }
    );
    await expect(
      downloadHfRepo({
        fetch: makeFetch({}),
        streamFetch,
        fs,
        repo: 'owner/name',
        targetDir: '/m',
        files: ['a.bin'],
      })
    ).rejects.toThrow(/short read for a\.bin: got 3 of 10 bytes/);
    expect(await fs.exists(`/m/a.bin${HF_INCOMPLETE_SUFFIX}`)).toBe(true);
  });

  it('cancels the body of an error status without touching the VFS', async () => {
    const { fetch: streamFetch, cancelled } = makeStreamFetch({});
    await expect(
      downloadHfRepo({
        fetch: makeFetch({}),
        streamFetch,
        fs,
        repo: 'owner/name',
        targetDir: '/m',
        files: ['missing.bin'],
      })
    ).rejects.toThrow(/HTTP 404 Not Found for missing\.bin/);
    expect(cancelled).toHaveLength(1);
    expect(await fs.exists('/m/missing.bin')).toBe(false);
  });

  it('attaches the host to a transport failure', async () => {
    const streamFetch: StreamingFetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(
      downloadHfRepo({
        fetch: makeFetch({}),
        streamFetch,
        fs,
        repo: 'owner/name',
        targetDir: '/m',
        files: ['a.bin'],
      })
    ).rejects.toThrow(/request to huggingface\.co failed \(Failed to fetch\)/);
  });
});

describe('HF_ENDPOINT override', () => {
  it('builds every hub URL on the configured endpoint', async () => {
    const fs = await newFs();
    const recorder = { calls: [] as string[] };
    const fetch = makeFetch({ 'a.txt': bytes('A') }, recorder);
    await downloadHfRepo({
      fetch,
      fs,
      repo: 'owner/name',
      targetDir: '/m',
      endpoint: 'http://127.0.0.1:8791/',
    });
    expect(recorder.calls.length).toBeGreaterThan(0);
    for (const url of recorder.calls) {
      expect(url.startsWith('http://127.0.0.1:8791/')).toBe(true);
    }
    expect(recorder.calls.some((c) => c.includes('/api/models/owner/name/tree/main'))).toBe(true);
    expect(recorder.calls.some((c) => c.endsWith('/owner/name/resolve/main/a.txt'))).toBe(true);
  });

  it('normalizes endpoints and falls back to huggingface.co for junk', async () => {
    const { DEFAULT_HF_ENDPOINT, resolveHfEndpoint } = await import(
      '../../../src/shell/supplemental-commands/hf-download.js'
    );
    expect(resolveHfEndpoint(undefined)).toBe(DEFAULT_HF_ENDPOINT);
    expect(resolveHfEndpoint('  ')).toBe(DEFAULT_HF_ENDPOINT);
    expect(resolveHfEndpoint('http://127.0.0.1:8791/')).toBe('http://127.0.0.1:8791');
    expect(resolveHfEndpoint('https://mirror.example/hf/')).toBe('https://mirror.example/hf');
    expect(resolveHfEndpoint('ftp://nope')).toBe(DEFAULT_HF_ENDPOINT);
    expect(resolveHfEndpoint('not a url')).toBe(DEFAULT_HF_ENDPOINT);
  });
});
