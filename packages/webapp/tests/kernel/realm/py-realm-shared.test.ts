/**
 * Pin the Pyodide runtime-CDN URL to the installed package version.
 * The `PYODIDE_RUNTIME_CDN` constant is the single documented
 * runtime-CDN exception (Wave 8); the loader resolves from the
 * ipk-installed npm package via `realm-factory.ts`. If the pinned
 * version drifts from `node_modules/pyodide/package.json`, the
 * loader and the CDN-hosted wheel ecosystem disagree.
 */

import type { PyodideInterface } from 'pyodide';
import { version as pyodidePackageVersion } from 'pyodide/package.json';
import { describe, expect, it, vi } from 'vitest';
import rootPackageJson from '../../../../../package.json';
import {
  PYODIDE_RUNTIME_CDN,
  PYODIDE_VERSION,
  runPyRealm,
} from '../../../src/kernel/realm/py-realm-shared.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import type { RealmDoneMsg, RealmInitMsg } from '../../../src/kernel/realm/realm-types.js';
import {
  type LockEntry,
  serializePyproject,
  serializeUvLock,
} from '../../../src/shell/di/manifest.js';

describe('Pyodide version resolution', () => {
  it('uses the installed pyodide package version for the runtime-CDN exception', () => {
    expect(PYODIDE_VERSION).toBe(pyodidePackageVersion);
    expect(PYODIDE_RUNTIME_CDN).toBe(
      `https://cdn.jsdelivr.net/pyodide/v${pyodidePackageVersion}/full/`
    );
  });

  it('keeps the root pyodide dependency pinned to the installed package version', () => {
    const pyodideVersion = rootPackageJson.dependencies.pyodide;
    expect(pyodideVersion).toBe(pyodidePackageVersion);
  });
});

/**
 * Manifest-activation step (`activateManifest` inside `runPyRealm`).
 * Drives the realm boot through a fake pyodide + an in-memory `vfs`
 * RPC port so we can assert exactly which `loadPackage` /
 * `micropip.install` calls each `pyproject.toml` + `uv.lock` pair
 * triggers — without pulling a real wheel.
 */
describe('runPyRealm manifest activation', () => {
  /**
   * A `RealmPortLike` that answers the realm's `vfs` RPC
   * (`exists` / `readFile`) from an in-memory file map keyed by
   * absolute VFS path. An absent path reports `exists:false` and a
   * `readFile` miss rejects with ENOENT (mirrors the kernel VFS).
   * Non-RPC outbound messages (`realm-done`) are recorded on
   * `postMessage.mock.calls` for assertions.
   */
  function makeRpcPort(files: Map<string, string>): RealmPortLike {
    let handler: ((event: MessageEvent) => void) | null = null;
    const respond = (id: number, body: { result?: unknown; error?: string }): void => {
      queueMicrotask(() =>
        handler?.({ data: { type: 'realm-rpc-res', id, ...body } } as MessageEvent)
      );
    };
    const postMessage = vi.fn((msg: unknown) => {
      const req = msg as {
        type?: string;
        id?: number;
        channel?: string;
        op?: string;
        args?: unknown[];
      };
      if (req?.type !== 'realm-rpc-req' || req.channel !== 'vfs') return;
      const path = req.args?.[0] as string;
      if (req.op === 'exists') {
        respond(req.id as number, { result: files.has(path) });
      } else if (req.op === 'readFile') {
        const content = files.get(path);
        if (content === undefined) respond(req.id as number, { error: `ENOENT: ${path}` });
        else respond(req.id as number, { result: content });
      } else {
        respond(req.id as number, { error: `unexpected vfs op ${req.op}` });
      }
    });
    return {
      postMessage,
      addEventListener: vi.fn((_type: 'message', h: (event: MessageEvent) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };
  }

  function makeFakePyodide(
    loadPackage: ReturnType<typeof vi.fn>,
    runPythonAsync: ReturnType<typeof vi.fn>
  ): PyodideInterface {
    return {
      loadPackage,
      setStdout: vi.fn(),
      setStderr: vi.fn(),
      setStdin: vi.fn(),
      registerJsModule: vi.fn(),
      runPythonAsync,
      runPython: vi.fn(),
      globals: { set: vi.fn(), get: vi.fn(() => 0) },
      FS: { chdir: vi.fn() },
    } as unknown as PyodideInterface;
  }

  function makeInit(): RealmInitMsg {
    return {
      type: 'realm-init',
      kind: 'py',
      code: 'print(1)',
      argv: [],
      env: {},
      cwd: '/workspace',
      filename: '<eval>',
      pyodideIndexURL: 'file:///fake/pyodide/',
    };
  }

  function manifestFiles(deps: string[], entries: LockEntry[]): Map<string, string> {
    const files = new Map<string, string>();
    files.set(
      '/workspace/pyproject.toml',
      serializePyproject({ name: 'workspace', version: '0.1.0', dependencies: deps })
    );
    files.set('/workspace/uv.lock', serializeUvLock(entries));
    return files;
  }

  function cdnEntry(name: string, version: string): LockEntry {
    return {
      name,
      version,
      source: 'pyodide-cdn',
      fileName: `${name}-${version}-py3-none-any.whl`,
      sha256: `sha-${name}`,
    };
  }

  function pypiEntry(name: string, version: string, fileName: string): LockEntry {
    return { name, version, source: 'pypi', fileName, sha256: `sha-${name}` };
  }

  function doneMessage(port: RealmPortLike): RealmDoneMsg | undefined {
    return (port.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as { type: string })
      .find((m): m is RealmDoneMsg => m.type === 'realm-done');
  }

  function postedTypes(port: RealmPortLike): string[] {
    return (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { type: string }).type
    );
  }

  /** loadPackage arg arrays excluding the always-first micropip preload. */
  function activationLoadCalls(loadPackage: ReturnType<typeof vi.fn>): string[][] {
    return loadPackage.mock.calls.slice(1).map((c) => c[0] as string[]);
  }

  /** runPythonAsync sources containing a manifest `micropip.install` line. */
  function installCalls(runPythonAsync: ReturnType<typeof vi.fn>): string[] {
    return runPythonAsync.mock.calls
      .map((c) => c[0] as string)
      .filter((s) => typeof s === 'string' && s.includes('micropip.install'));
  }

  function run(
    files: Map<string, string>,
    loadPackage: ReturnType<typeof vi.fn>,
    runPythonAsync: ReturnType<typeof vi.fn>
  ): { port: RealmPortLike; pyodide: PyodideInterface; promise: Promise<void> } {
    const pyodide = makeFakePyodide(loadPackage, runPythonAsync);
    const port = makeRpcPort(files);
    const loaderImport = async (): Promise<typeof import('pyodide')> =>
      ({ loadPyodide: vi.fn(async () => pyodide) }) as unknown as typeof import('pyodide');
    return { port, pyodide, promise: runPyRealm(makeInit(), port, loaderImport) };
  }

  it('no manifest: no activation calls and no warnings', async () => {
    const loadPackage = vi.fn(async () => undefined);
    const runPythonAsync = vi.fn(async () => undefined);
    const { port, promise } = run(new Map(), loadPackage, runPythonAsync);
    await promise;

    // Only the micropip preload — no manifest means no activation.
    expect(loadPackage).toHaveBeenCalledTimes(1);
    expect(loadPackage).toHaveBeenCalledWith(['micropip']);
    expect(installCalls(runPythonAsync)).toEqual([]);
    expect(doneMessage(port)?.stderr).not.toContain('Warning:');
  });

  it('all pyodide-cdn deps: loadPackage per dep in order, no micropip.install', async () => {
    const loadPackage = vi.fn(async () => undefined);
    const runPythonAsync = vi.fn(async () => undefined);
    const files = manifestFiles(
      ['micropip==0.11.1', 'numpy==2.2.0'],
      [cdnEntry('micropip', '0.11.1'), cdnEntry('numpy', '2.2.0')]
    );
    const { port, promise } = run(files, loadPackage, runPythonAsync);
    await promise;

    // Per-package activation (one loadPackage call each), in manifest
    // order, after the leading micropip preload.
    expect(activationLoadCalls(loadPackage)).toEqual([['micropip'], ['numpy']]);
    expect(installCalls(runPythonAsync)).toEqual([]);
    expect(doneMessage(port)?.stderr).not.toContain('Warning:');
  });

  it('mixed sources: pyodide-cdn via loadPackage, pypi via micropip.install(emfs:...)', async () => {
    const loadPackage = vi.fn(async () => undefined);
    const runPythonAsync = vi.fn(async () => undefined);
    const files = manifestFiles(
      ['numpy==2.2.0', 'attrs==25.1.0'],
      [cdnEntry('numpy', '2.2.0'), pypiEntry('attrs', '25.1.0', 'attrs-25.1.0-py3-none-any.whl')]
    );
    const { promise } = run(files, loadPackage, runPythonAsync);
    await promise;

    expect(activationLoadCalls(loadPackage)).toEqual([['numpy']]);
    const installs = installCalls(runPythonAsync);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain('emfs:/workspace/python_wheels/attrs-25.1.0-py3-none-any.whl');
  });

  it('declared but no lock entry: warns and skips activation', async () => {
    const loadPackage = vi.fn(async () => undefined);
    const runPythonAsync = vi.fn(async () => undefined);
    const files = manifestFiles(['pandas==2.2.3'], []);
    const { port, promise } = run(files, loadPackage, runPythonAsync);
    await promise;

    // Only the micropip preload ran; pandas has no integrity pin.
    expect(activationLoadCalls(loadPackage)).toEqual([]);
    expect(installCalls(runPythonAsync)).toEqual([]);
    const stderr = doneMessage(port)?.stderr ?? '';
    expect(stderr).toContain('no integrity pin for `pandas`');
    expect(stderr).toContain('di sync');
  });

  it('loadPackage rejects: warns but boot continues through subsequent steps', async () => {
    const loadPackage = vi.fn(async (names: string[]) => {
      if (names[0] === 'numpy') throw new Error('CDN miss');
      return undefined;
    });
    const runPythonAsync = vi.fn(async () => undefined);
    const files = manifestFiles(['numpy==2.2.0'], [cdnEntry('numpy', '2.2.0')]);
    const { port, pyodide, promise } = run(files, loadPackage, runPythonAsync);
    await promise;

    // Activation failure is a warning, never a realm-error.
    expect(postedTypes(port)).toContain('realm-done');
    expect(postedTypes(port)).not.toContain('realm-error');
    expect(doneMessage(port)?.stderr).toContain('activation of `numpy` failed');
    // Subsequent boot steps still ran (chdir + the Python runner).
    expect(pyodide.FS.chdir as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('/workspace');
    expect(runPythonAsync).toHaveBeenCalled();
  });

  it('order preserved: loadPackage activation follows manifest declaration order', async () => {
    const loadPackage = vi.fn(async () => undefined);
    const runPythonAsync = vi.fn(async () => undefined);
    const files = manifestFiles(['a==1', 'b==2'], [cdnEntry('a', '1'), cdnEntry('b', '2')]);
    const { promise } = run(files, loadPackage, runPythonAsync);
    await promise;

    expect(activationLoadCalls(loadPackage)).toEqual([['a'], ['b']]);
  });

  // Regression for Wave 2b: the OPFS mount that surfaces
  // `/workspace/python_wheels` into the Pyodide FS must run BEFORE
  // manifest activation, otherwise the `pypi` branch's
  // `micropip.install('emfs:…')` reads a wheel the FS doesn't have yet
  // and a cold-boot `di add <pypi-pkg>` fails with FileNotFoundError.
  it('mount setup precedes pypi manifest activation', async () => {
    const events: string[] = [];
    const getDirectory = vi.fn(async () => {
      events.push('mount');
      throw new Error('no opfs in test env');
    });
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    try {
      const loadPackage = vi.fn(async () => undefined);
      const runPythonAsync = vi.fn(async (src: string) => {
        if (typeof src === 'string' && src.includes('micropip.install')) events.push('activate');
        return undefined;
      });
      const files = manifestFiles(
        ['humanize==4.12.1'],
        [pypiEntry('humanize', '4.12.1', 'humanize-4.12.1-py3-none-any.whl')]
      );
      const pyodide = makeFakePyodide(loadPackage, runPythonAsync);
      const port = makeRpcPort(files);
      const loaderImport = async (): Promise<typeof import('pyodide')> =>
        ({ loadPyodide: vi.fn(async () => pyodide) }) as unknown as typeof import('pyodide');
      const init: RealmInitMsg = { ...makeInit(), opfsMountDbName: 'kernel-db' };
      await runPyRealm(init, port, loaderImport);

      expect(getDirectory).toHaveBeenCalled();
      expect(events).toContain('mount');
      expect(events).toContain('activate');
      expect(events.indexOf('mount')).toBeLessThan(events.indexOf('activate'));

      const installs = installCalls(runPythonAsync);
      expect(installs[0]).toContain(
        'emfs:/workspace/python_wheels/humanize-4.12.1-py3-none-any.whl'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
