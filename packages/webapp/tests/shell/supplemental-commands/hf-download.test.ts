import 'fake-indexeddb/auto';
import type { SecureFetch, SecureFetchOptions } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import {
  downloadHfRepo,
  HfFileDownloadError,
  type HfFileEvent,
} from '../../../src/shell/supplemental-commands/hf-download.js';

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

  it('does not list when an explicit file set is provided', async () => {
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
    expect(recorder.calls.some((c) => c.includes('/api/models/'))).toBe(false);
    expect(result.downloaded).toBe(1);
    expect(await fs.exists('/m/b.txt')).toBe(false);
  });

  it('skips byte-present files unless force is set', async () => {
    const fetch = makeFetch({ 'a.txt': bytes('A') });
    await fs.mkdir('/m', { recursive: true });
    await fs.writeFile('/m/a.txt', bytes('PRE'));
    const skip = await downloadHfRepo({ fetch, fs, repo: 'owner/name', targetDir: '/m' });
    expect(skip).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(await fs.readFile('/m/a.txt')).toBe('PRE');
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
});
