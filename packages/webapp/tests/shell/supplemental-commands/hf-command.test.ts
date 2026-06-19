import 'fake-indexeddb/auto';
import type { IFileSystem, SecureFetch, SecureFetchOptions } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import {
  createHfCommand,
  parseDownloadArgs,
  resolveTargetDir,
} from '../../../src/shell/supplemental-commands/hf-command.js';

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
      return { isFile: s.isFile, isDirectory: s.isDirectory, size: s.size } as never;
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
    // No tree probe when files are explicit.
    expect(recorder.calls.some((c) => c.includes('/api/models/'))).toBe(false);
  });

  it('skips existing files by default and re-downloads under --force', async () => {
    const recorder = { calls: [] as string[] };
    const fetch = makeFetch({ 'owner/name': { files: { 'a.txt': bytes('A') } } }, recorder);
    const cmd = createHfCommand({ fetch });
    await fs.mkdir('/m', { recursive: true });
    await fs.writeFile('/m/a.txt', bytes('PREEXISTING'));

    const skipRun = await cmd.execute(
      ['download', 'owner/name', 'a.txt', '--to', '/m'],
      ctxOf(fs) as never
    );
    expect(skipRun.exitCode).toBe(0);
    expect(skipRun.stderr).toMatch(/skipped a\.txt/);
    expect(await fs.readFile('/m/a.txt')).toBe('PREEXISTING');

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

  it('honors --revision when listing and resolving files', async () => {
    const recorder = { calls: [] as string[] };
    const fetch = makeFetch({ 'owner/name': { files: { 'a.txt': bytes('A') } } }, recorder);
    const cmd = createHfCommand({ fetch });
    const r = await cmd.execute(['download', 'owner/name', '--revision', 'v9'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(recorder.calls.some((c) => c.includes('/tree/v9'))).toBe(true);
    expect(recorder.calls.some((c) => c.includes('/resolve/v9/'))).toBe(true);
  });
});
