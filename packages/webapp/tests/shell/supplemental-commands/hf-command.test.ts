import 'fake-indexeddb/auto';
import type { FsStat, IFileSystem, SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import {
  createHfCommand,
  parseDownloadArgs,
  resolveTargetDir,
} from '../../../src/shell/supplemental-commands/hf-command.js';

type SecureFetchOptions = NonNullable<Parameters<SecureFetch>[1]>;

type FetchResult = Awaited<ReturnType<SecureFetch>>;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-hf-command-${dbCounter++}`, wipe: true });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

interface RepoFixture {
  files: Record<string, Uint8Array>;
}

function makeFetch(
  byRepo: Record<string, RepoFixture>,
  recorder?: { calls: string[] }
): SecureFetch {
  return (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    recorder?.calls.push(url);
    const apiMatch = url.match(
      /^https:\/\/huggingface\.co\/api\/models\/([^/]+\/[^/]+)\/tree\/([^?]+)/
    );
    if (apiMatch) {
      const repo = apiMatch[1];
      const fixture = byRepo[repo];
      if (!fixture) {
        return { status: 404, statusText: 'Not Found', headers: {}, body: bytes(''), url };
      }
      const entries = Object.entries(fixture.files).map(([path, b]) => ({
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
    const resolveMatch = url.match(
      /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/
    );
    if (resolveMatch) {
      const repo = resolveMatch[1];
      const file = resolveMatch[2];
      const body = byRepo[repo]?.files[file];
      if (!body) {
        return { status: 404, statusText: 'Not Found', headers: {}, body: bytes(''), url };
      }
      return { status: 200, statusText: 'OK', headers: {}, body, url };
    }
    return { status: 404, statusText: 'Not Found', headers: {}, body: bytes(''), url };
  }) as unknown as SecureFetch;
}

function ctxOf(fs: VirtualFS, cwd = '/workspace') {
  const fsLike: Partial<IFileSystem> = {
    exists: (p: string) => fs.exists(p),
    stat: async (p: string) => {
      const s = await fs.stat(p);

      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'directory',
        size: s.size,
      } as FsStat;
    },
    mkdir: async (p: string, opts?: { recursive?: boolean }) => {
      await fs.mkdir(p, { recursive: opts?.recursive ?? true });
    },
    writeFile: async (p: string, data: Uint8Array | string) => {
      await fs.writeFile(p, data);
    },
    resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
  };
  return {
    fs: fsLike as IFileSystem,
    cwd,
    env: new Map<string, string>(),
    stdin: new Uint8Array() as unknown as never,
  };
}

describe('hf-command parseDownloadArgs', () => {
  it('parses a bare repo with default revision', () => {
    const r = parseDownloadArgs(['owner/name']);
    expect(r).toEqual({ repo: 'owner/name', files: [], to: null, revision: 'main', force: false });
  });

  it('parses explicit files, --to, --revision, --force', () => {
    const r = parseDownloadArgs([
      'owner/name',
      'a.txt',
      'b.bin',
      '--to',
      '/m',
      '--revision',
      'v1',
      '--force',
    ]);
    expect(r).toEqual({
      repo: 'owner/name',
      files: ['a.txt', 'b.bin'],
      to: '/m',
      revision: 'v1',
      force: true,
    });
  });

  it('rejects an invalid repo shape', () => {
    expect(parseDownloadArgs(['bad'])).toEqual({
      error: "invalid repo 'bad' — expected <owner>/<name>",
    });
  });

  it('rejects an unknown option', () => {
    expect(parseDownloadArgs(['owner/name', '--bogus'])).toEqual({
      error: 'unknown option: --bogus',
    });
  });

  it('requires a value for --to and --revision', () => {
    expect(parseDownloadArgs(['owner/name', '--to'])).toEqual({ error: '--to requires a value' });
    expect(parseDownloadArgs(['owner/name', '--revision'])).toEqual({
      error: '--revision requires a value',
    });
  });
});

describe('hf-command resolveTargetDir', () => {
  it('defaults to /workspace/models/<repo>', () => {
    expect(resolveTargetDir('owner/name', null, '/cwd')).toBe('/workspace/models/owner/name');
  });
  it('uses --to verbatim when absolute', () => {
    expect(resolveTargetDir('owner/name', '/m', '/cwd')).toBe('/m');
    expect(resolveTargetDir('owner/name', '/m/', '/cwd')).toBe('/m');
  });
  it('resolves --to relative to cwd when not absolute', () => {
    expect(resolveTargetDir('owner/name', 'sub', '/cwd')).toBe('/cwd/sub');
  });
});

describe('createHfCommand', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await newFs();
  });

  it('registers under name `hf`', () => {
    const cmd = createHfCommand({ fetch: makeFetch({}) });
    expect(cmd.name).toBe('hf');
  });

  it('prints help and exits non-zero when called with no args', async () => {
    const cmd = createHfCommand({ fetch: makeFetch({}) });
    const r = await cmd.execute([], ctxOf(fs) as never);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/hf download/);
  });

  it('--help exits 0', async () => {
    const cmd = createHfCommand({ fetch: makeFetch({}) });
    const r = await cmd.execute(['--help'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/hf download/);
  });

  it('unknown subcommand fails with a clean message', async () => {
    const cmd = createHfCommand({ fetch: makeFetch({}) });
    const r = await cmd.execute(['bogus'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unknown subcommand: bogus/);
  });

  it('download lists then fetches every repo file into the default /workspace/models target', async () => {
    const fetch = makeFetch({
      'owner/name': { files: { 'config.json': bytes('{}'), 'weights.bin': bytes('abcd') } },
    });
    const cmd = createHfCommand({ fetch });
    const r = await cmd.execute(['download', 'owner/name'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/workspace/models/owner/name/config.json')).toBe(true);
    expect(await fs.exists('/workspace/models/owner/name/weights.bin')).toBe(true);
    expect(r.stderr).toMatch(/2 downloaded, 0 skipped/);
  });

  it('download <repo> <file...> only fetches the listed files', async () => {
    const recorder = { calls: [] as string[] };
    const fetch = makeFetch(
      { 'owner/name': { files: { 'a.txt': bytes('A'), 'b.txt': bytes('B') } } },
      recorder
    );
    const cmd = createHfCommand({ fetch });
    const r = await cmd.execute(
      ['download', 'owner/name', 'a.txt', '--to', '/m'],
      ctxOf(fs) as never
    );
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/m/a.txt')).toBe(true);
    expect(await fs.exists('/m/b.txt')).toBe(false);

    const apiCalls = recorder.calls.filter((c) => c.includes('/api/models/'));
    expect(apiCalls).toEqual(['https://huggingface.co/api/models/owner/name/tree/main']);
  });

  it('skips existing files by default and re-downloads under --force', async () => {
    const recorder = { calls: [] as string[] };
    const fetch = makeFetch({ 'owner/name': { files: { 'a.txt': bytes('A') } } }, recorder);
    const cmd = createHfCommand({ fetch });
    await fs.mkdir('/m', { recursive: true });

    await fs.writeFile('/m/a.txt', bytes('P'));

    const skipRun = await cmd.execute(
      ['download', 'owner/name', 'a.txt', '--to', '/m'],
      ctxOf(fs) as never
    );
    expect(skipRun.exitCode).toBe(0);
    expect(skipRun.stderr).toMatch(/skipped a\.txt/);
    expect(await fs.readFile('/m/a.txt')).toBe('P');

    const forceRun = await cmd.execute(
      ['download', 'owner/name', 'a.txt', '--to', '/m', '--force'],
      ctxOf(fs) as never
    );
    expect(forceRun.exitCode).toBe(0);
    expect(forceRun.stderr).toMatch(/downloaded a\.txt/);
    expect(await fs.readFile('/m/a.txt')).toBe('A');
  });

  it('surfaces a clean error when the repo is missing on the hub', async () => {
    const cmd = createHfCommand({ fetch: makeFetch({}) });
    const r = await cmd.execute(['download', 'owner/missing'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/HF API 404/);
  });

  it('wraps a fetch transport failure with the failing HF host name', async () => {
    const failing: SecureFetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as SecureFetch;
    const cmd = createHfCommand({ fetch: failing });
    const r = await cmd.execute(['download', 'owner/name'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/huggingface\.co/);
    expect(r.stderr).toMatch(/Failed to fetch/);
    expect(r.stderr).toMatch(/bridge fetch-proxy/);
  });

  it('wraps per-file fetch transport failures with the failing host name', async () => {
    let call = 0;
    const failingOnResolve: SecureFetch = (async (url: string) => {
      call += 1;
      if (url.includes('/resolve/')) throw new TypeError('Failed to fetch');
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: bytes(JSON.stringify([{ type: 'file', path: 'a.txt', size: 1 }])),
        url,
      };
    }) as unknown as SecureFetch;
    const cmd = createHfCommand({ fetch: failingOnResolve });
    const r = await cmd.execute(['download', 'owner/name'], ctxOf(fs) as never);
    expect(call).toBeGreaterThanOrEqual(2);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/huggingface\.co/);
    expect(r.stderr).toMatch(/Failed to fetch/);
  });

  it('honors --revision when listing and resolving files', async () => {
    const recorder = { calls: [] as string[] };
    const fetch = makeFetch({ 'owner/name': { files: { 'a.txt': bytes('A') } } }, recorder);
    const cmd = createHfCommand({ fetch });
    const r = await cmd.execute(['download', 'owner/name', '--revision', 'v9'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(recorder.calls.some((c) => c.includes('/tree/v9'))).toBe(true);
    expect(recorder.calls.some((c) => c.includes('/resolve/v9/'))).toBe(true);
  });

  it('streams throttled progress lines to a live sink and keeps them out of the result', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`s${i}`, new Uint8Array(1024 * 1024)])
    );
    let clock = 0;
    const fetch = makeFetch({ 'owner/name': { files } });

    const slowFetch = (async (url: string, opts?: SecureFetchOptions) => {
      if (url.includes('/resolve/')) clock += 3000;
      return fetch(url, opts);
    }) as unknown as SecureFetch;
    const cmd = createHfCommand({ fetch: slowFetch, now: () => clock });
    const live: string[] = [];
    const ctx = { ...ctxOf(fs), writeStdout: (c: string) => live.push(c) };
    const r = await cmd.execute(['download', 'owner/name', '-j', '1'], ctx as never);
    expect(r.exitCode).toBe(0);
    const progress = live.filter((l) => /files,/.test(l));

    expect(progress).toEqual([
      'hf: 1/4 files, 1.0 MB of 4.0 MB, 341.3 KB/s, ~9s left\n',
      'hf: 3/4 files, 3.0 MB of 4.0 MB, 341.3 KB/s, ~3s left\n',
      'hf: 4/4 files, 4.0 MB of 4.0 MB, 341.3 KB/s\n',
    ]);
    expect(live[0]).toMatch(/4 file\(s\) listed/);
    expect(r.stderr).not.toMatch(/files,/);
    expect(r.stderr).toMatch(
      /4 downloaded, 0 skipped, 4\.0 MB total into .* in 12s \(341\.3 KB\/s\)/
    );
  });

  it('keeps a nonzero sub-byte rate in the download summary', async () => {
    let clock = 0;
    const fetch = makeFetch({ 'owner/name': { files: { tiny: new Uint8Array(1) } } });
    const slowFetch = (async (url: string, opts?: SecureFetchOptions) => {
      if (url.includes('/resolve/')) clock += 3000;
      return fetch(url, opts);
    }) as unknown as SecureFetch;
    const cmd = createHfCommand({ fetch: slowFetch, now: () => clock });
    const r = await cmd.execute(['download', 'owner/name'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/1 downloaded, 0 skipped, 1 B total into .* in 3s \(0\.3 B\/s\)/);
  });

  it('prints no progress lines without a live sink, and no rate when nothing downloaded', async () => {
    const fetch = makeFetch({ 'owner/name': { files: { 'a.txt': bytes('A') } } });
    await fs.mkdir('/m', { recursive: true });
    await fs.writeFile('/m/a.txt', bytes('A'));
    const cmd = createHfCommand({ fetch });
    const r = await cmd.execute(['download', 'owner/name', '--to', '/m'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/files,/);
    expect(r.stderr).toMatch(/0 downloaded, 1 skipped, 1 B total into \/m\n$/);
  });

  it('passes the command abort signal through so a kill stops the downloads', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const fetch = (async (url: string, opts?: SecureFetchOptions): Promise<FetchResult> => {
      seen.push(opts?.signal);
      if (url.includes('/api/models/')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: bytes(JSON.stringify([{ type: 'file', path: 'a', size: 1 }])),
          url,
        };
      }
      controller.abort();
      throw new Error('The operation was aborted');
    }) as unknown as SecureFetch;
    const cmd = createHfCommand({ fetch });
    const ctx = { ...ctxOf(fs), signal: controller.signal };
    const r = await cmd.execute(['download', 'owner/name'], ctx as never);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/download aborted/);
    expect(seen.at(-1)).toBeInstanceOf(AbortSignal);
  });

  it('formats multi-gigabyte totals in GB', async () => {
    const big = { byteLength: 3 * 1024 ** 3 } as Uint8Array;
    const fetch = (async (url: string): Promise<FetchResult> => {
      if (url.includes('/api/models/')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: bytes(JSON.stringify([{ type: 'file', path: 'w', size: big.byteLength }])),
          url,
        };
      }
      return { status: 200, statusText: 'OK', headers: {}, body: big, url };
    }) as unknown as SecureFetch;
    const fakeFs = {
      ...ctxOf(fs).fs,
      writeFile: async () => undefined,
    };
    const cmd = createHfCommand({ fetch });
    const r = await cmd.execute(['download', 'owner/name'], { ...ctxOf(fs), fs: fakeFs } as never);
    expect(r.stderr).toMatch(/downloaded w \(3\.0 GB\)/);
  });
});

describe('hf-command download pool flags', () => {
  it('parses --concurrency, -j and --max-in-flight-mb', () => {
    expect(parseDownloadArgs(['o/n', '--concurrency', '8'])).toMatchObject({ concurrency: 8 });
    expect(parseDownloadArgs(['o/n', '-j', '2'])).toMatchObject({ concurrency: 2 });
    expect(parseDownloadArgs(['o/n', '--max-in-flight-mb', '512'])).toMatchObject({
      maxInFlightMb: 512,
    });
  });

  it('rejects a missing, zero, negative or fractional value', () => {
    expect(parseDownloadArgs(['o/n', '--concurrency'])).toEqual({
      error: '--concurrency requires a value',
    });
    for (const bad of ['0', '-1', '1.5', 'many']) {
      expect(parseDownloadArgs(['o/n', '-j', bad])).toEqual({
        error: `-j must be a positive integer, got '${bad}'`,
      });
    }
  });

  it('documents the pool flags and their defaults in --help', async () => {
    const cmd = createHfCommand({ fetch: makeFetch({}) });
    const fs = await newFs();
    const r = await cmd.execute(['download', '--help'], ctxOf(fs) as never);
    expect(r.stdout).toMatch(/--concurrency, -j\s+4 files at once/);
    expect(r.stdout).toMatch(/--max-in-flight-mb\s+128 MB/);
  });

  it('limits a real download to the requested concurrency', async () => {
    const fs = await newFs();
    let active = 0;
    let maxActive = 0;
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, bytes('x')]));
    const inner = makeFetch({ 'owner/name': { files } });
    const fetch = (async (url: string, opts?: SecureFetchOptions) => {
      if (!url.includes('/resolve/')) return inner(url, opts);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return inner(url, opts);
    }) as unknown as SecureFetch;
    const cmd = createHfCommand({ fetch });
    const r = await cmd.execute(
      ['download', 'owner/name', '--concurrency', '2'],
      ctxOf(fs) as never
    );
    expect(r.exitCode).toBe(0);
    expect(maxActive).toBe(2);
  });
});
