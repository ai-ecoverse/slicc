import 'fake-indexeddb/auto';
import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../../src/core/logger.js';
import { VirtualFS } from '../../../src/fs/index.js';
import { PYODIDE_VERSION } from '../../../src/kernel/realm/py-realm-shared.js';
import { resolveLockfile } from '../../../src/shell/di/lockfile.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const LOCKFILE_URL = `${CDN_BASE}pyodide-lock.json`;
const LOCKFILE_PATH = '/workspace/node_modules/pyodide/pyodide-lock.json';

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-lockfile-${dbCounter++}`, wipe: true });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const LOCK_JSON = JSON.stringify({
  packages: {
    micropip: {
      name: 'micropip',
      version: '0.6.0',
      file_name: 'micropip-0.6.0-py3-none-any.whl',
      sha256: 'a'.repeat(64),
    },
    numpy: {
      name: 'numpy',
      version: '1.26.4',
      file_name: 'numpy-1.26.4-cp312-cp312-pyodide.whl',
      sha256: 'b'.repeat(64),
    },
  },
});

async function writeLockfile(fs: VirtualFS, json: string): Promise<void> {
  await fs.mkdir('/workspace/node_modules/pyodide', { recursive: true });
  await fs.writeFile(LOCKFILE_PATH, json);
}

interface MockSpec {
  status?: number;
  body?: string;
  calls: string[];
}

function makeFetch(spec: MockSpec): SecureFetch {
  return (async (url: string): Promise<FetchResult> => {
    spec.calls.push(url);
    return {
      status: spec.status ?? 200,
      statusText: spec.status && spec.status >= 400 ? 'Not Found' : 'OK',
      headers: {},
      body: bytes(spec.body ?? LOCK_JSON),
      url,
    };
  }) as unknown as SecureFetch;
}

describe('di lockfile — CDN auto-fetch', () => {
  beforeEach(() => {
    resetLoggerDedupForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves from the local VFS lockfile without issuing a fetch', async () => {
    const fs = await newFs();
    await writeLockfile(fs, LOCK_JSON);
    const calls: string[] = [];
    const fetch = makeFetch({ calls });

    const resolved = await resolveLockfile(fs, fetch, 'micropip');

    expect(resolved).toMatchObject({ name: 'micropip', version: '0.6.0', source: 'pyodide-cdn' });
    expect(calls).toEqual([]);
  });

  it('fetches the lockfile from the CDN on a VFS miss and caches it', async () => {
    const fs = await newFs();
    const calls: string[] = [];
    const fetch = makeFetch({ calls });

    const first = await resolveLockfile(fs, fetch, 'micropip');
    const second = await resolveLockfile(fs, fetch, 'numpy');

    expect(first).toMatchObject({ name: 'micropip', version: '0.6.0', source: 'pyodide-cdn' });
    expect(second).toMatchObject({ name: 'numpy', version: '1.26.4', source: 'pyodide-cdn' });
    expect(calls).toEqual([LOCKFILE_URL]);
  });

  it('returns null and logs when the CDN responds non-2xx', async () => {
    const fs = await newFs();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    const fetch = makeFetch({ status: 404, calls });

    const resolved = await resolveLockfile(fs, fetch, 'micropip');

    expect(resolved).toBeNull();
    expect(calls).toEqual([LOCKFILE_URL]);
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null and logs when the CDN throws a network error', async () => {
    const fs = await newFs();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = (async () => {
      throw new Error('offline');
    }) as unknown as SecureFetch;

    const resolved = await resolveLockfile(fs, fetch, 'micropip');

    expect(resolved).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null, logs, and does not cache malformed CDN JSON', async () => {
    const fs = await newFs();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    const fetch = makeFetch({ body: '{ not json', calls });

    const first = await resolveLockfile(fs, fetch, 'micropip');
    const second = await resolveLockfile(fs, fetch, 'micropip');

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    expect(calls).toEqual([LOCKFILE_URL, LOCKFILE_URL]);
  });

  it('caches per VirtualFS — a fresh instance re-fetches', async () => {
    const calls: string[] = [];
    const fetch = makeFetch({ calls });

    const fsA = await newFs();
    await resolveLockfile(fsA, fetch, 'micropip');
    await resolveLockfile(fsA, fetch, 'numpy');
    const fsB = await newFs();
    await resolveLockfile(fsB, fetch, 'micropip');

    expect(calls).toEqual([LOCKFILE_URL, LOCKFILE_URL]);
  });
});
