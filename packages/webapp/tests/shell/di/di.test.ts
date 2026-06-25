import 'fake-indexeddb/auto';
import type { SecureFetch } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { PYODIDE_VERSION } from '../../../src/kernel/realm/py-realm-shared.js';
import { sha256Hex } from '../../../src/shell/di/fetcher.js';
import { diAdd, diList, parseSpec, WHEELS_DIR } from '../../../src/shell/di/index.js';
import { findManifestDir, parsePyproject, parseUvLock } from '../../../src/shell/di/manifest.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-di-${dbCounter++}`, wipe: true });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

interface FetchSpec {
  json?: Record<string, unknown>;
  files?: Record<string, Uint8Array>;
  calls?: string[];
}

function makeFetch(spec: FetchSpec): SecureFetch {
  return (async (url: string): Promise<FetchResult> => {
    spec.calls?.push(url);
    if (spec.json && url in spec.json) {
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: bytes(JSON.stringify(spec.json[url])),
        url,
      };
    }
    if (spec.files && url in spec.files) {
      return { status: 200, statusText: 'OK', headers: {}, body: spec.files[url], url };
    }
    return { status: 404, statusText: 'Not Found', headers: {}, body: bytes(''), url };
  }) as unknown as SecureFetch;
}

async function writeLockfile(
  fs: VirtualFS,
  packages: Record<string, { name: string; version: string; file_name: string; sha256: string }>
): Promise<void> {
  await fs.mkdir('/workspace/node_modules/pyodide', { recursive: true });
  await fs.writeFile(
    '/workspace/node_modules/pyodide/pyodide-lock.json',
    JSON.stringify({ packages })
  );
}

function pypiJson(name: string, version: string, fileName: string, url: string, sha256: string) {
  return {
    info: { name, version },
    urls: [{ packagetype: 'bdist_wheel', filename: fileName, url, digests: { sha256 } }],
  };
}

describe('di resolver — backend dispatch', () => {
  it('dispatches a lockfile hit to the Pyodide CDN', async () => {
    const fs = await newFs();
    const wheel = bytes('micropip-wheel-bytes');
    const sha = await sha256Hex(wheel);
    const fileName = 'micropip-0.6.0-py3-none-any.whl';
    await writeLockfile(fs, {
      micropip: { name: 'micropip', version: '0.6.0', file_name: fileName, sha256: sha },
    });
    const calls: string[] = [];
    const fetch = makeFetch({ files: { [CDN_BASE + fileName]: wheel }, calls });

    const out = await diAdd(fs, fetch, '/workspace', ['micropip']);

    expect(out.errors).toEqual([]);
    expect(out.results[0]).toMatchObject({
      name: 'micropip',
      version: '0.6.0',
      source: 'pyodide-cdn',
      fileName,
      staged: true,
    });
    expect(calls.some((u) => u.startsWith(CDN_BASE))).toBe(true);
    expect(await fs.exists(`${WHEELS_DIR}/${fileName}`)).toBe(true);
  });

  it('dispatches a lockfile miss to PyPI', async () => {
    const fs = await newFs();
    const wheel = bytes('attrs-wheel-bytes');
    const sha = await sha256Hex(wheel);
    const fileName = 'attrs-23.2.0-py3-none-any.whl';
    const wheelUrl = `https://files.pythonhosted.org/packages/aa/${fileName}`;
    const fetch = makeFetch({
      json: {
        'https://pypi.org/pypi/attrs/json': pypiJson('attrs', '23.2.0', fileName, wheelUrl, sha),
      },
      files: { [wheelUrl]: wheel },
    });

    const out = await diAdd(fs, fetch, '/workspace', ['attrs']);

    expect(out.errors).toEqual([]);
    expect(out.results[0]).toMatchObject({ name: 'attrs', version: '23.2.0', source: 'pypi' });
  });

  it('rejects a non-pure-Python PyPI wheel with a clear error', async () => {
    const fs = await newFs();
    const fileName = 'numpy-1.26.4-cp312-cp312-manylinux_2_17_x86_64.whl';
    const fetch = makeFetch({
      json: {
        'https://pypi.org/pypi/numpy/json': pypiJson(
          'numpy',
          '1.26.4',
          fileName,
          `https://x/${fileName}`,
          '00'
        ),
      },
    });

    const out = await diAdd(fs, fetch, '/workspace', ['numpy']);

    expect(out.results).toEqual([]);
    expect(out.errors[0].error.message).toMatch(/platform-specific|pure-Python/);
  });
});

describe('di integrity — sha256 verification', () => {
  it('aborts a CDN sha256 mismatch without writing to the VFS', async () => {
    const fs = await newFs();
    const wheel = bytes('real-bytes');
    const wrongSha = 'deadbeef'.repeat(8);
    const fileName = 'pkg-1.0.0-py3-none-any.whl';
    await writeLockfile(fs, {
      pkg: { name: 'pkg', version: '1.0.0', file_name: fileName, sha256: wrongSha },
    });
    const fetch = makeFetch({ files: { [CDN_BASE + fileName]: wheel } });

    const out = await diAdd(fs, fetch, '/workspace', ['pkg']);

    expect(out.results).toEqual([]);
    expect(out.errors[0].error.message).toMatch(/sha256 mismatch/);
    expect(await fs.exists(`${WHEELS_DIR}/${fileName}`)).toBe(false);
    expect(await fs.exists('/workspace/pyproject.toml')).toBe(false);
  });

  it('aborts a PyPI sha256 mismatch without writing to the VFS', async () => {
    const fs = await newFs();
    const wheel = bytes('pypi-real-bytes');
    const fileName = 'thing-2.0.0-py3-none-any.whl';
    const wheelUrl = `https://files.pythonhosted.org/${fileName}`;
    const fetch = makeFetch({
      json: {
        'https://pypi.org/pypi/thing/json': pypiJson(
          'thing',
          '2.0.0',
          fileName,
          wheelUrl,
          'badc0ffee'.padEnd(64, '0')
        ),
      },
      files: { [wheelUrl]: wheel },
    });

    const out = await diAdd(fs, fetch, '/workspace', ['thing']);

    expect(out.errors[0].error.message).toMatch(/sha256 mismatch/);
    expect(await fs.exists(`${WHEELS_DIR}/${fileName}`)).toBe(false);
  });
});

describe('di staging — flat wheel directory', () => {
  async function stagedFetch(fs: VirtualFS) {
    const wheel = bytes('micropip-wheel-bytes');
    const sha = await sha256Hex(wheel);
    const fileName = 'micropip-0.6.0-py3-none-any.whl';
    await writeLockfile(fs, {
      micropip: { name: 'micropip', version: '0.6.0', file_name: fileName, sha256: sha },
    });
    return { fetch: makeFetch({ files: { [CDN_BASE + fileName]: wheel } }), fileName, sha };
  }

  it('treats a byte-identical second add as a no-op', async () => {
    const fs = await newFs();
    const { fetch } = await stagedFetch(fs);
    const first = await diAdd(fs, fetch, '/workspace', ['micropip']);
    expect(first.results[0].staged).toBe(true);
    const second = await diAdd(fs, fetch, '/workspace', ['micropip']);
    expect(second.errors).toEqual([]);
    expect(second.results[0].staged).toBe(false);
  });

  it('errors when a different wheel already occupies the target path', async () => {
    const fs = await newFs();
    const { fetch, fileName } = await stagedFetch(fs);
    await fs.mkdir(WHEELS_DIR, { recursive: true });
    await fs.writeFile(`${WHEELS_DIR}/${fileName}`, bytes('totally-different'));

    const out = await diAdd(fs, fetch, '/workspace', ['micropip']);

    expect(out.results).toEqual([]);
    expect(out.errors[0].error.message).toMatch(/different bytes|refusing to overwrite/);
  });
});

describe('di manifest — pyproject.toml + uv.lock', () => {
  async function addMicropip(fs: VirtualFS, cwd: string) {
    const wheel = bytes('micropip-wheel-bytes');
    const sha = await sha256Hex(wheel);
    const fileName = 'micropip-0.6.0-py3-none-any.whl';
    await writeLockfile(fs, {
      micropip: { name: 'micropip', version: '0.6.0', file_name: fileName, sha256: sha },
    });
    const fetch = makeFetch({ files: { [CDN_BASE + fileName]: wheel } });
    return diAdd(fs, fetch, cwd, ['micropip']);
  }

  it('creates pyproject.toml + uv.lock when absent and is re-readable', async () => {
    const fs = await newFs();
    await addMicropip(fs, '/workspace');

    const pyproject = parsePyproject((await fs.readFile('/workspace/pyproject.toml')) as string);
    expect(pyproject.dependencies).toContain('micropip==0.6.0');

    const lock = parseUvLock((await fs.readFile('/workspace/uv.lock')) as string);
    expect(lock).toHaveLength(1);
    expect(lock[0]).toMatchObject({ name: 'micropip', version: '0.6.0', source: 'pyodide-cdn' });
  });

  it('updates the dependencies array idempotently', async () => {
    const fs = await newFs();
    await addMicropip(fs, '/workspace');
    await addMicropip(fs, '/workspace');
    const pyproject = parsePyproject((await fs.readFile('/workspace/pyproject.toml')) as string);
    expect(pyproject.dependencies).toEqual(['micropip==0.6.0']);
  });

  it('discovers an existing pyproject.toml from a nested cwd', async () => {
    const fs = await newFs();
    await fs.mkdir('/workspace/sub/deep', { recursive: true });
    await fs.writeFile(
      '/workspace/pyproject.toml',
      '[project]\nname = "x"\nversion = "0.0.1"\ndependencies = []\n'
    );
    expect(await findManifestDir(fs, '/workspace/sub/deep')).toBe('/workspace');

    await addMicropip(fs, '/workspace/sub/deep');
    expect(await fs.exists('/workspace/pyproject.toml')).toBe(true);
    expect(await fs.exists('/workspace/sub/deep/pyproject.toml')).toBe(false);
  });

  it('lists recorded packages and returns null when no manifest exists', async () => {
    const fs = await newFs();
    expect(await diList(fs, '/workspace')).toBeNull();
    await addMicropip(fs, '/workspace');
    const rows = await diList(fs, '/workspace');
    expect(rows).toContainEqual({ name: 'micropip', version: '0.6.0', source: 'pyodide-cdn' });
  });
});

describe('di parseSpec', () => {
  it('parses a bare name as latest', () => {
    expect(parseSpec('numpy')).toMatchObject({ name: 'numpy' });
    expect(parseSpec('numpy').version).toBeUndefined();
  });

  it('parses name@version and name==version', () => {
    expect(parseSpec('numpy@1.2.3')).toEqual({ name: 'numpy', version: '1.2.3' });
    expect(parseSpec('numpy==1.2.3')).toEqual({ name: 'numpy', version: '1.2.3' });
  });

  it('rejects an invalid package name', () => {
    expect(() => parseSpec('bad name!')).toThrow(/invalid package name/);
  });
});
