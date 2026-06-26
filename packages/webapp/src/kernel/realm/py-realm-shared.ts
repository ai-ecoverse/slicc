/**
 * Shared Pyodide constants + the Python realm execution engine.
 *
 * `runPyRealm(init, port)` is the entry point both the standalone
 * worker (`py-realm-worker.ts`) and the in-process test factory
 * use, so we don't duplicate `loadPyodide` + VFS sync logic in two
 * places.
 *
 * Constants (`PYODIDE_VERSION`, `PYODIDE_RUNTIME_CDN`,
 * `PYTHON_RUNNER`) also live here so the kernel-side
 * `realm-factory.ts` and the worker can share the same pin
 * without crossing into the supplemental-commands layer.
 */

import type { SecureFetch } from 'just-bash';
import type { PyodideInterface } from 'pyodide';
import { version as pyodidePackageVersion } from 'pyodide/package.json';
import type { VirtualFS } from '../../fs/index.js';
import { splitPath } from '../../fs/path-utils.js';
import { fetchAndVerify } from '../../shell/di/fetcher.js';
import {
  findManifestDir,
  type LockEntry,
  loadPyproject,
  loadUvLock,
  normalizePackageName,
  splitDependency,
} from '../../shell/di/manifest.js';
import { resolve as ipkResolve, type ModuleReader } from '../../shell/ipk/resolver.js';
import {
  resolvePinnedPackageVersion,
  toPreviewUrl,
} from '../../shell/supplemental-commands/shared.js';
import { installMountBombs } from './mount-bomb-fs.js';
import {
  createBufferedOpfsSahProvider,
  createOpfsSyncFs,
  flushPendingOpfsOps,
  type OpfsMount,
  type OpfsSyncFsPlugin,
  prewalkOpfsTree,
} from './opfs-sync-fs.js';
import { installPythonMountGuard } from './python-mount-guard.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmErrorMsg,
  RealmInitMsg,
  RealmMountPoint,
  SerializedFetchResponse,
} from './realm-types.js';
import { registerSliccFsModule } from './slicc-fs-module.js';

export const PYODIDE_VERSION = resolvePinnedPackageVersion('pyodide', pyodidePackageVersion);

/**
 * The SINGLE documented runtime-CDN exception. Wave 8 moved the
 * pyodide JS loader from jsdelivr to the ipk-installed npm package
 * at `/workspace/node_modules/pyodide/`; Wave 13c then moved the
 * standalone runtime read off the preview SW onto direct VFS-bytes
 * loads via realm RPC (`loadPyodideAssetsViaRpc`). Pyodide's
 * package-wheel ecosystem still lives on jsdelivr, so this constant
 * pins the `cdn.jsdelivr.net/pyodide/v<VERSION>/full/` base for any
 * wheel-fetching path (`pyodide.loadPackage('numpy')`) to keep it
 * consistent with the loader version.
 *
 * Every other CDN-resolver in the webapp was retired in Waves 1-7;
 * do NOT add another. New runtime assets must be installed via
 * `ipk add <pkg>` and resolved through VFS reads.
 */
export const PYODIDE_RUNTIME_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Canonical guidance error surfaced when the standalone browser
 * float cannot find an ipk-installed pyodide package in VFS
 * `node_modules`. Mirrors the wording of `FFMPEG_CORE_NOT_INSTALLED`
 * / `MAGICK_NOT_INSTALLED` so every install-required loader speaks
 * the same shape. Interpolates {@link PYODIDE_VERSION} so the
 * guidance pins users at the exact codebase-supported build — an
 * unversioned `ipk add pyodide` can resolve to a newer pyodide whose
 * runtime assets bypass the VFS-bytes loader (R5).
 */
export const PYODIDE_NOT_INSTALLED = `pyodide is not installed in node_modules: run \`ipk add pyodide@${PYODIDE_VERSION}\` (no network fallback)`;

/**
 * Filenames the standalone VFS-bytes loader reads out of the
 * resolved pyodide package directory. Pinned here so the worker-side
 * read (`loadPyodideAssetsViaRpc`) and the kernel-side existence
 * check (`tryResolvePyodideAssetRoot`) agree on the contract.
 */
const PYODIDE_ASSET_FILES = {
  asmJs: 'pyodide.asm.mjs',
  asmWasm: 'pyodide.asm.wasm',
  stdlibZip: 'python_stdlib.zip',
  lockJson: 'pyodide-lock.json',
} as const;

/**
 * Kernel-side helper: resolve an ipk-installed `pyodide/package.json`
 * via the shared resolver and return the package directory (e.g.
 * `/workspace/node_modules/pyodide`) when all four runtime assets
 * are present. Returns `null` on any resolution / existence miss so
 * the caller (`python-command.ts`) can surface
 * {@link PYODIDE_NOT_INSTALLED} before booting the realm worker.
 *
 * Mirrors `tryLoadFfmpegCoreFromNodeModules`'s null-means-not-installed
 * contract — exported so the resolution behavior is unit-testable
 * without booting the Python realm.
 */
export async function tryResolvePyodideAssetRoot(ipk: {
  reader: ModuleReader;
  fromDir: string;
}): Promise<string | null> {
  let resolved;
  try {
    resolved = await ipkResolve('pyodide/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  for (const file of Object.values(PYODIDE_ASSET_FILES)) {
    if (!(await ipk.reader.exists(`${pkgDir}/${file}`))) return null;
  }
  return pkgDir;
}

/**
 * The four pyodide runtime assets the worker reads out of the VFS
 * via realm RPC. {@link asmJsSource} and {@link lockJsonString} are
 * text; {@link asmWasmBytes} and {@link stdlibBytes} are binary.
 */
export interface PyodideAssetBytes {
  asmJsSource: string;
  asmWasmBytes: Uint8Array;
  stdlibBytes: Uint8Array;
  lockJsonString: string;
}

/**
 * Worker-side helper: read the four pyodide assets from `assetRoot`
 * via the realm's `vfs` RPC channel (`readFile` for text,
 * `readFileBinary` for bytes). Returns `null` on any read failure
 * so `runPyRealm` surfaces {@link PYODIDE_NOT_INSTALLED} as a
 * `realm-error` — defensive parity with the kernel-side existence
 * check (a partial install with `package.json` but a missing asset
 * still degrades cleanly).
 */
export async function loadPyodideAssetsViaRpc(
  rpc: RealmRpcClient,
  assetRoot: string
): Promise<PyodideAssetBytes | null> {
  try {
    const [asmJsSource, asmWasmRaw, stdlibRaw, lockJsonString] = await Promise.all([
      rpc.call<string>('vfs', 'readFile', [`${assetRoot}/${PYODIDE_ASSET_FILES.asmJs}`]),
      rpc.call<Uint8Array | ArrayBuffer>('vfs', 'readFileBinary', [
        `${assetRoot}/${PYODIDE_ASSET_FILES.asmWasm}`,
      ]),
      rpc.call<Uint8Array | ArrayBuffer>('vfs', 'readFileBinary', [
        `${assetRoot}/${PYODIDE_ASSET_FILES.stdlibZip}`,
      ]),
      rpc.call<string>('vfs', 'readFile', [`${assetRoot}/${PYODIDE_ASSET_FILES.lockJson}`]),
    ]);
    return {
      asmJsSource,
      asmWasmBytes: asmWasmRaw instanceof Uint8Array ? asmWasmRaw : new Uint8Array(asmWasmRaw),
      stdlibBytes: stdlibRaw instanceof Uint8Array ? stdlibRaw : new Uint8Array(stdlibRaw),
      lockJsonString,
    };
  } catch {
    return null;
  }
}

/**
 * Install a scoped `globalThis.fetch` shim that answers a single
 * `${indexURL}pyodide.asm.wasm` request with `wasmBytes` as
 * `application/wasm`, forwarding every other request to the
 * original `fetch`. Pyodide's loader has hooks for the lock file
 * and stdlib zip but `instantiateWasm` always reads the asm wasm
 * via `fetch(indexURL + 'pyodide.asm.wasm')` — this shim is the
 * one indexURL holdout the VFS-bytes path needs to cover.
 *
 * Returns a `restore()` that puts the original `fetch` back. The
 * caller MUST invoke it in a `finally` so a `loadPyodide` rejection
 * doesn't leak the shim into subsequent worker fetches. `restore()`
 * is idempotent — repeat calls are no-ops.
 */
export function installPyodideAsmWasmFetchShim(
  indexURL: string,
  wasmBytes: Uint8Array
): { restore: () => void } {
  const targetUrl = indexURL + PYODIDE_ASSET_FILES.asmWasm;
  const origFetch = globalThis.fetch;
  let active = true;
  const shimmed: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url === targetUrl) {
      // `Response` constructor copies the bytes into the body
      // stream synchronously, so revoking the source `Uint8Array`
      // after `loadPyodide` resolves is safe. Cast handles the
      // `Uint8Array<ArrayBufferLike>` vs `BodyInit`'s `ArrayBuffer`
      // generic mismatch in current `lib.dom.d.ts`.
      return Promise.resolve(
        new Response(wasmBytes as unknown as BodyInit, {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }
    return origFetch(input, init);
  };
  globalThis.fetch = shimmed;
  return {
    restore: (): void => {
      if (!active) return;
      active = false;
      // Only restore if our shim is still the installed fetch — a
      // nested install would have wrapped us further, and clobbering
      // it would un-shim the outer one too. Best-effort.
      if (globalThis.fetch === shimmed) globalThis.fetch = origFetch;
    },
  };
}

/**
 * The Python "runner" — wraps user code in `compile`/`exec` with a
 * `__main__` namespace, captures `SystemExit` exit code into
 * `__slicc_exit_code`, and prints any other traceback. Identical
 * to the legacy in-kernel Python execution path.
 */
export const PYTHON_RUNNER = `
import sys
import traceback

__slicc_exit_code = 0
try:
    sys.argv = __slicc_argv
    exec(compile(__slicc_code, __slicc_filename, "exec"), {"__name__": "__main__", "__file__": __slicc_filename})
except SystemExit as exc:
    code = exc.code
    if code is None:
        __slicc_exit_code = 0
    elif isinstance(code, int):
        __slicc_exit_code = code
    else:
        print(code, file=sys.stderr)
        __slicc_exit_code = 1
except BaseException:
    traceback.print_exc()
    __slicc_exit_code = 1
`;

// ---------------------------------------------------------------------------
// Python realm execution engine
// ---------------------------------------------------------------------------

/**
 * Standalone-browser VFS-bytes load path. Reads the four pyodide
 * runtime assets out of the VFS via realm RPC (`loadPyodideAssetsViaRpc`),
 * materializes the asm.mjs + stdlib zip as blob URLs, dynamically
 * imports the asm.mjs blob to capture its default-exported module
 * factory (passed to `loadPyodide` as `createPyodideModule`),
 * installs the scoped `pyodide.asm.wasm` fetch shim, and calls
 * `loadPyodide` with a synthetic `slicc-pyodide://local/`
 * indexURL plus `lockFileContents` / `stdLibURL`. Restores the
 * `fetch` shim and revokes blob URLs on BOTH success and failure
 * (via try/finally) so the shim never leaks into subsequent worker
 * fetches.
 *
 * Surfaces {@link PYODIDE_NOT_INSTALLED} when any asset read fails
 * — mirrors `tryLoadFfmpegCoreFromNodeModules`'s null-means-not-installed
 * contract and gives the canonical `ipk add pyodide` guidance.
 */
export async function loadPyodideFromVfsAssets(
  mod: typeof import('pyodide'),
  assetRoot: string,
  rpc: RealmRpcClient
): Promise<PyodideInterface> {
  const assets = await loadPyodideAssetsViaRpc(rpc, assetRoot);
  if (!assets) throw new Error(PYODIDE_NOT_INSTALLED);

  const coreJsBlobUrl = URL.createObjectURL(
    new Blob([assets.asmJsSource], { type: 'text/javascript' })
  );
  // Pyodide 314 renamed `pyodide.asm.js` → `pyodide.asm.mjs` and made
  // it a true ES module whose default export is the Emscripten module
  // factory (`export default _createPyodideModule`).
  type PyodideConfig = NonNullable<Parameters<typeof mod.loadPyodide>[0]>;
  type CreatePyodideModuleFn = PyodideConfig['createPyodideModule'];
  const stdlibBlobUrl = URL.createObjectURL(
    // Cast handles the `Uint8Array<ArrayBufferLike>` vs `BlobPart`'s
    // `ArrayBufferView<ArrayBuffer>` generic mismatch in current
    // `lib.dom.d.ts`; the runtime semantics are identical.
    new Blob([assets.stdlibBytes as unknown as BlobPart], { type: 'application/zip' })
  );
  // Synthetic indexURL — pyodide's loader concatenates filenames
  // onto it for the asm wasm fetch (handled by the shim) and stores
  // it on the resolved interface for later wheel loads (those route
  // through `packageBaseUrl` / `PYODIDE_RUNTIME_CDN` instead, so the
  // synthetic stickiness is a no-op).
  const indexURL = `slicc-pyodide://local/${crypto.randomUUID()}/`;
  const shim = installPyodideAsmWasmFetchShim(indexURL, assets.asmWasmBytes);
  try {
    // Dynamic-import the blob URL as an ES module and capture its
    // default export (the module factory), then hand it to
    // `loadPyodide` as the `createPyodideModule` option. This is the
    // documented 314 service-worker/bundler path: it short-circuits
    // the loader's own `${indexURL}pyodide.asm.mjs` import so the asm
    // module is never re-fetched from the synthetic indexURL. Replaces
    // the pre-314 classic-script `globalThis._createPyodideModule`
    // side-effect trick.
    const asmModule = (await import(/* @vite-ignore */ coreJsBlobUrl)) as {
      default: CreatePyodideModuleFn;
    };
    return await mod.loadPyodide({
      indexURL,
      lockFileContents: assets.lockJsonString,
      stdLibURL: stdlibBlobUrl,
      createPyodideModule: asmModule.default,
      // Resolve the lockfile's relative `file_name` entries against the
      // flat-staged wheel dir `di add` writes to. MUST end with `/` so
      // Pyodide joins `<base>/<file_name>` cleanly; `toPreviewUrl`
      // preserves the trailing slash from the VFS path.
      packageBaseUrl: toPreviewUrl('/workspace/python_wheels/'),
    });
  } finally {
    shim.restore();
    URL.revokeObjectURL(coreJsBlobUrl);
    URL.revokeObjectURL(stdlibBlobUrl);
  }
}

/**
 * Run a `kind:'py'` realm against `port`. Loads Pyodide via the
 * supplied `loaderImport` (default: dynamic `import('pyodide')`),
 * mounts the per-dir OPFS subtrees via `OPFS_SYNC_FS`, runs the
 * user code, flushes the mounts, then posts `realm-done`. Used by
 * both `py-realm-worker.ts` (worker context) and the in-process
 * test factory.
 */
export async function runPyRealm(
  init: RealmInitMsg,
  port: RealmPortLike,
  loaderImport: () => Promise<typeof import('pyodide')> = () => import('pyodide')
): Promise<void> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const rpc = new RealmRpcClient(port);

  let pyodide: PyodideInterface;
  try {
    const mod = await loaderImport();
    pyodide = init.pyodideAssetRoot
      ? await loadPyodideFromVfsAssets(mod, init.pyodideAssetRoot, rpc)
      : await mod.loadPyodide({
          indexURL: init.pyodideIndexURL,
        });
  } catch (err) {
    rpc.dispose();
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = {
      type: 'realm-error',
      message: `loadPyodide: ${message}`,
    };
    port.postMessage(errMsg);
    return;
  }

  const pushWarning = (msg: string): void => {
    stderrChunks.push(`Warning: ${msg}\n`);
  };

  await preloadMicropip(pyodide, rpc, pushWarning);

  // Mount setup MUST precede manifest activation: the `pypi` branch of
  // `activateLockEntry` installs wheels via `micropip.install('emfs:…')`,
  // which reads them from the Pyodide FS. The OPFS mount is what surfaces
  // `/workspace/python_wheels` into that FS, so activating first leaves a
  // cold-boot `di add <pypi-pkg>` failing with `FileNotFoundError`.
  const opfsMounts = await mountOpfsIfNeeded(pyodide, init, pushWarning);
  await installMountOverlays(pyodide, init, pushWarning);

  await activateManifest(pyodide, rpc, init, pushWarning);

  await registerSliccFsModuleSafe(pyodide, rpc, pushWarning);

  try {
    pyodide.FS.chdir(init.cwd);
  } catch {
    /* dir may not exist in Pyodide FS */
  }

  configurePyodideIo(pyodide, init, stdoutChunks, stderrChunks);

  const exitCode = await executePythonCode(pyodide, stderrChunks);

  await flushOpfsIfNeeded(opfsMounts, init, rpc, pushWarning);

  rpc.dispose();
  const done: RealmDoneMsg = {
    type: 'realm-done',
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
  port.postMessage(done);
}

/**
 * Absolute VFS directory the flat-staged wheels live in (`di add`
 * writes here; {@link loadPyodideFromVfsAssets} points pyodide's
 * `packageBaseUrl` at the preview-URL form of the same dir). The
 * `pypi` activation path resolves each lock entry's `file_name`
 * against this so micropip reads it via the `emfs:` mounted FS.
 */
const PYTHON_WHEELS_DIR = '/workspace/python_wheels';

/**
 * Preload `micropip` after boot so power users can `import micropip` /
 * `micropip.install('emfs://…')` ad-hoc without a prior `di add`. The
 * wheel resolves against the lockfile-relative `packageBaseUrl` set in
 * {@link loadPyodideFromVfsAssets} (flat-staged dir) or the runtime CDN
 * otherwise. Best-effort: a miss on an empty staging dir degrades to a
 * warning rather than hard-failing the realm boot.
 *
 * On a cold VFS the flat-staged wheel dir is empty, so `loadPackage`
 * 404s against `packageBaseUrl`, the micropip module never loads, and
 * every later `pypi`-source activation fails with `ModuleNotFoundError:
 * micropip`. {@link ensureMicropipWheelStaged} closes that gap by
 * fetching the canonical micropip wheel (resolved from the ipk-installed
 * lockfile) into the staging dir before the `loadPackage` call.
 */
async function preloadMicropip(
  pyodide: PyodideInterface,
  rpc: RealmRpcClient,
  pushWarning: WarningSink
): Promise<void> {
  await ensureMicropipWheelStaged(rpc, pushWarning);
  try {
    await pyodide.loadPackage(['micropip']);
  } catch (err) {
    pushWarning(`micropip preload failed: ${describeRealmError(err)}`);
  }
}

/** Where `ipk add pyodide@<version>` lands the lockfile in the VFS. */
const PYODIDE_LOCKFILE_VFS_PATH = '/workspace/node_modules/pyodide/pyodide-lock.json';

/** Bound the wheel fetch so a hung CDN doesn't stall realm boot. */
const MICROPIP_FETCH_TIMEOUT_MS = 10_000;

/**
 * Per-RPC-client memo of the staging promise. Each realm boot gets a
 * fresh `RealmRpcClient` (and worker), so this only dedupes repeat
 * calls within one boot — mirrors the Wave 1a lockfile `WeakMap` so the
 * staging round-trip never runs twice against the same client.
 */
const micropipStagingCache = new WeakMap<RealmRpcClient, Promise<void>>();

/**
 * Ensure the canonical `micropip` wheel exists under
 * {@link PYTHON_WHEELS_DIR} so {@link preloadMicropip}'s `loadPackage`
 * resolves it against the flat-staged `packageBaseUrl` instead of
 * 404ing on a cold VFS. Memoized per `rpc` client.
 */
function ensureMicropipWheelStaged(rpc: RealmRpcClient, pushWarning: WarningSink): Promise<void> {
  const cached = micropipStagingCache.get(rpc);
  if (cached) return cached;
  const promise = stageMicropipWheel(rpc, pushWarning);
  micropipStagingCache.set(rpc, promise);
  return promise;
}

interface MicropipLockEntry {
  name?: string;
  file_name?: string;
  sha256?: string;
}

/**
 * Read the ipk-installed pyodide lockfile via `vfs` RPC, find the
 * `micropip` entry, and — when its wheel isn't already staged — fetch
 * it from {@link PYODIDE_RUNTIME_CDN} (sha256-verified via
 * {@link fetchAndVerify}) and write it into {@link PYTHON_WHEELS_DIR}.
 *
 * Best-effort throughout: a missing/unparseable lockfile, an absent
 * micropip entry, or a fetch/write failure degrades to a `pushWarning`
 * so realm boot still completes — `loadPackage` then surfaces the same
 * degraded warning it did before this staging step existed.
 */
async function stageMicropipWheel(rpc: RealmRpcClient, pushWarning: WarningSink): Promise<void> {
  let entry: MicropipLockEntry | undefined;
  try {
    if (!(await rpc.call<boolean>('vfs', 'exists', [PYODIDE_LOCKFILE_VFS_PATH]))) return;
    const lockText = await rpc.call<string>('vfs', 'readFile', [PYODIDE_LOCKFILE_VFS_PATH]);
    const parsed = JSON.parse(lockText) as {
      packages?: Record<string, MicropipLockEntry>;
    };
    for (const [key, candidate] of Object.entries(parsed.packages ?? {})) {
      if (!candidate?.file_name) continue;
      if (normalizePackageName(candidate.name ?? key) === 'micropip') {
        entry = candidate;
        break;
      }
    }
  } catch (err) {
    pushWarning(`micropip wheel staging skipped: ${describeRealmError(err)}`);
    return;
  }
  if (!entry?.file_name || !entry.sha256) return;

  const wheelPath = `${PYTHON_WHEELS_DIR}/${entry.file_name}`;
  try {
    if (await rpc.call<boolean>('vfs', 'exists', [wheelPath])) return;

    const bytes = await fetchAndVerify(createRealmFetch(rpc), {
      url: `${PYODIDE_RUNTIME_CDN}${entry.file_name}`,
      sha256: entry.sha256,
      label: 'micropip wheel',
      timeoutMs: MICROPIP_FETCH_TIMEOUT_MS,
    });
    await rpc.call('vfs', 'mkdir', [PYTHON_WHEELS_DIR]);
    await rpc.call('vfs', 'writeFileBinary', [wheelPath, bytes]);
  } catch (err) {
    pushWarning(`micropip wheel staging failed: ${describeRealmError(err)}`);
  }
}

/**
 * Adapt the realm's `fetch` RPC channel into the `SecureFetch` shape
 * `fetchAndVerify` expects. The host-side `dispatchFetch` returns a
 * {@link SerializedFetchResponse} whose body is already a `Uint8Array`,
 * matching `SecureFetch`'s `FetchResult` field-for-field. `timeoutMs`
 * can't ride the structured-clone RPC boundary, so it's enforced
 * realm-side via {@link raceWithTimeout} (the in-flight RPC keeps
 * running but the caller stops waiting and degrades).
 */
function createRealmFetch(rpc: RealmRpcClient): SecureFetch {
  return async (url, options) => {
    const init: RequestInit = {
      method: options?.method ?? 'GET',
      ...(options?.headers ? { headers: options.headers } : {}),
      ...(options?.body !== undefined ? { body: options.body } : {}),
    };
    const res = await raceWithTimeout(
      rpc.call<SerializedFetchResponse>('fetch', 'request', [url, init]),
      options?.timeoutMs ?? MICROPIP_FETCH_TIMEOUT_MS,
      url
    );
    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body: res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body),
      url: res.url,
    };
  };
}

/** Reject with a timeout error if `promise` doesn't settle within `ms`. */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`request to ${url} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * `VirtualFS`-shaped read-only adapter over the realm's `vfs` RPC
 * channel. The `di` manifest helpers ({@link findManifestDir},
 * {@link loadPyproject}, {@link loadUvLock}) only ever call
 * `exists` + `readFile`, so the realm worker — which has a
 * `RealmRpcClient` but no direct `VirtualFS` — reuses the exact
 * same parsers unchanged by routing those two ops over RPC.
 */
function createRealmManifestVfs(rpc: RealmRpcClient): VirtualFS {
  return {
    exists: (path: string) => rpc.call<boolean>('vfs', 'exists', [path]),
    readFile: (path: string) => rpc.call<string>('vfs', 'readFile', [path]),
  } as unknown as VirtualFS;
}

/**
 * Read the project's `pyproject.toml` + `uv.lock` (walking up from
 * `init.cwd`) and activate each declared dependency in manifest
 * order so `di add <pkg> && python3 -c 'import <pkg>'` works with no
 * in-script `micropip.install`. Source dispatch is keyed off the
 * `uv.lock` entry: `pyodide-cdn` → `pyodide.loadPackage([name])`,
 * `pypi` → `micropip.install('emfs:<wheel>')`.
 *
 * Every failure degrades to a `pushWarning` and the loop continues —
 * a missing manifest is a silent no-op, an undeclared lock entry or
 * a broken wheel warns but never turns realm boot into a
 * `realm-error`.
 */
async function activateManifest(
  pyodide: PyodideInterface,
  rpc: RealmRpcClient,
  init: RealmInitMsg,
  pushWarning: WarningSink
): Promise<void> {
  const fs = createRealmManifestVfs(rpc);

  let manifestDir: string | null;
  try {
    manifestDir = await findManifestDir(fs, init.cwd);
  } catch (err) {
    pushWarning(`manifest discovery failed: ${describeRealmError(err)}`);
    return;
  }
  if (manifestDir === null) return;

  let dependencies: string[];
  let lockEntries: LockEntry[];
  try {
    const [project, lock] = await Promise.all([
      loadPyproject(fs, manifestDir),
      loadUvLock(fs, manifestDir),
    ]);
    dependencies = project.dependencies;
    lockEntries = lock;
  } catch (err) {
    pushWarning(`manifest read failed: ${describeRealmError(err)}`);
    return;
  }

  const lockByName = new Map<string, LockEntry>();
  for (const entry of lockEntries) lockByName.set(normalizePackageName(entry.name), entry);

  for (const dep of dependencies) {
    const { name } = splitDependency(dep);
    if (!name) continue;
    const entry = lockByName.get(normalizePackageName(name));
    if (!entry) {
      pushWarning(`no integrity pin for \`${name}\`; run \`di sync\` to repair`);
      continue;
    }
    await activateLockEntry(pyodide, entry, pushWarning);
  }
}

/**
 * Activate a single resolved {@link LockEntry} by its `source`. Both
 * activation calls are wrapped so a rejecting `loadPackage` /
 * `micropip.install` (broken wheel, network-less CDN miss) degrades
 * to a warning rather than aborting the rest of the manifest. An
 * unrecognised `source` warns and is skipped (forward-compat for
 * future Wave 4 source kinds).
 */
async function activateLockEntry(
  pyodide: PyodideInterface,
  entry: LockEntry,
  pushWarning: WarningSink
): Promise<void> {
  switch (entry.source) {
    case 'pyodide-cdn':
      try {
        await pyodide.loadPackage([entry.name]);
      } catch (err) {
        pushWarning(`activation of \`${entry.name}\` failed: ${describeRealmError(err)}`);
      }
      return;
    case 'pypi':
      try {
        const wheelPath = `${PYTHON_WHEELS_DIR}/${entry.fileName}`;
        await pyodide.runPythonAsync(
          `import micropip; await micropip.install('emfs:${wheelPath}')`
        );
      } catch (err) {
        pushWarning(`activation of \`${entry.name}\` failed: ${describeRealmError(err)}`);
      }
      return;
    default:
      pushWarning(`unknown source \`${entry.source}\` for \`${entry.name}\`; skipping`);
  }
}

/** Mount OPFS dirs if the kernel provided an opfsMountDbName. */
async function mountOpfsIfNeeded(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  pushWarning: WarningSink
): Promise<OpfsRealmMount[]> {
  if (init.opfsMountDbName === undefined) return [];

  // Default `[cwd, '/tmp']` is deliberate: those are the two
  // directories Python code almost always reads from (the working
  // directory the user invoked from + the conventional scratch
  // location). Adding `/workspace/` or `/shared/` to the default
  // would mirror the entire workspace into Pyodide's FS on every
  // invocation — minutes per `python3 -c "print(1)"` even with the
  // bulk-RPC path. Callers that need wider visibility pass an
  // explicit `pyodideMountDirs`.
  const syncDirs = init.pyodideMountDirs ?? [init.cwd, '/tmp'];
  const mountPoints: RealmMountPoint[] = init.mountPoints ?? [];
  const exactMountPaths = new Set(mountPoints.map((m) => m.path));

  try {
    const mounted = await mountOpfsDirsAndSyncIn(
      pyodide,
      syncDirs,
      init.opfsMountDbName,
      pushWarning,
      { skipMountPaths: exactMountPaths }
    );
    return mounted.mounts;
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount failed: ${describeRealmError(err)}`);
    return [];
  }
}

/** Install mount bombs and Python mount guard for overlapping mount paths. */
async function installMountOverlays(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  pushWarning: WarningSink
): Promise<void> {
  const mountPoints: RealmMountPoint[] = init.mountPoints ?? [];
  if (mountPoints.length === 0) return;

  try {
    installMountBombs(
      pyodide.FS as unknown as Parameters<typeof installMountBombs>[0],
      mountPoints.map((mp) => mp.path),
      pushWarning
    );
  } catch (err) {
    pushWarning(`bomb overlay install failed: ${describeRealmError(err)}`);
  }

  // Python-level guard: the bomb FS sets a friendly `.message` on
  // its `ErrnoError`, but CPython rebuilds the OSError from the raw
  // integer errno for stdlib calls, so only "I/O error" survives.
  // This wraps the hot stdlib entry points and raises an OSError
  // carrying the guidance directly. Bomb FS remains as the C-level
  // backstop for paths the Python wrappers can't see (pandas fopen,
  // C extensions).
  try {
    await installPythonMountGuard(
      pyodide,
      mountPoints.map((mp) => mp.path)
    );
  } catch (err) {
    pushWarning(`python mount guard install failed: ${describeRealmError(err)}`);
  }
}

/** Register the async `slicc.fs` Python module with warning on failure. */
async function registerSliccFsModuleSafe(
  pyodide: PyodideInterface,
  rpc: RealmRpcClient,
  pushWarning: WarningSink
): Promise<void> {
  try {
    await registerSliccFsModule(pyodide, rpc);
  } catch (err) {
    pushWarning(`slicc.fs registration failed: ${describeRealmError(err)}`);
  }
}

/** Configure stdout, stderr, stdin, and globals for user code execution. */
function configurePyodideIo(
  pyodide: PyodideInterface,
  init: RealmInitMsg,
  stdoutChunks: string[],
  stderrChunks: string[]
): void {
  pyodide.setStdout({ batched: (msg: string) => stdoutChunks.push(msg + '\n') });
  pyodide.setStderr({ batched: (msg: string) => stderrChunks.push(msg + '\n') });

  let stdinConsumed = false;
  pyodide.setStdin({
    stdin: () => {
      if (stdinConsumed || !init.stdin) return null;
      stdinConsumed = true;
      return init.stdin;
    },
  });
  pyodide.globals.set('__slicc_code', init.code);
  pyodide.globals.set('__slicc_filename', init.filename);
  pyodide.globals.set('__slicc_argv', init.argv);
}

/** Execute the Python runner and return the exit code. */
async function executePythonCode(
  pyodide: PyodideInterface,
  stderrChunks: string[]
): Promise<number> {
  let exitCode: number;
  try {
    await pyodide.runPythonAsync(PYTHON_RUNNER);
    const raw = pyodide.globals.get('__slicc_exit_code');
    exitCode = typeof raw === 'number' ? raw : Number(raw ?? 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderrChunks.push(`${message}\n`);
    exitCode = 1;
  }

  try {
    pyodide.runPython('del __slicc_code, __slicc_filename, __slicc_argv, __slicc_exit_code');
  } catch {
    /* best-effort cleanup */
  }
  return exitCode;
}

/** Flush OPFS mounts and invalidate kernel VFS cache if applicable. */
async function flushOpfsIfNeeded(
  opfsMounts: OpfsRealmMount[],
  init: RealmInitMsg,
  rpc: RealmRpcClient,
  pushWarning: WarningSink
): Promise<void> {
  if (init.opfsMountDbName === undefined) return;

  try {
    await flushOpfsRealmMounts(opfsMounts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushWarning(`Pyodide→VFS OPFS flush failed: ${message}`);
  }
  // Invalidate the kernel VFS's in-memory cache for paths Python
  // wrote to via synchronous `open()`. The OPFS layer already has
  // the correct data (flushed above); this makes the kernel re-read
  // from OPFS on next access instead of serving stale cached content.
  try {
    await invalidateDirtyPathsInKernelVfs(opfsMounts, rpc);
  } catch (err) {
    pushWarning(`Pyodide→kernel VFS invalidation failed: ${describeRealmError(err)}`);
  }
}

// ---------------------------------------------------------------------------
// OPFS-native mount path (OPFS_SYNC_FS plugin)
// ---------------------------------------------------------------------------

type WarningSink = (message: string) => void;

/**
 * Top-level directory names Emscripten / Pyodide already own when
 * `loadPyodide` finishes. Mounting OPFS_SYNC_FS over any of these
 * collides with the built-in mount (Emscripten rejects with EBUSY)
 * or shadows runtime-critical state (`/lib` is Pyodide's stdlib).
 * Used by the cwd=='/' fan-out so a kernel-side `/tmp` OPFS dir
 * doesn't shadow Pyodide's writable scratch dir.
 */
const EMSCRIPTEN_BUILTIN_ROOT_DIRS = new Set(['dev', 'proc', 'lib', 'tmp', 'home']);

/**
 * Render any error from the realm mount/sync paths as a single
 * human-readable line. Emscripten's `ErrnoError` carries `.errno`
 * and (sometimes) `.code` but is not always `instanceof Error`, so
 * `String(err)` collapses it to `[object Object]`. This helper
 * surfaces the POSIX cause (name + message + errno + code) for
 * Emscripten-shaped throws, the message for real `Error`s, and
 * falls back to `String(err)` for everything else.
 */
export function describeRealmError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; errno?: unknown; code?: unknown };
    const hasErrno = typeof e.errno === 'number';
    const hasCode = typeof e.code === 'string';
    if (hasErrno || hasCode) {
      const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
      const message = typeof e.message === 'string' ? e.message : '';
      const detail: string[] = [];
      if (hasErrno) detail.push(`errno ${e.errno as number}`);
      if (hasCode) detail.push(e.code as string);
      const suffix = detail.length ? ` (${detail.join(', ')})` : '';
      return message ? `${name}: ${message}${suffix}` : `${name}${suffix}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Per-dir OPFS mount state the realm passes to
 * `flushOpfsRealmMounts` before `realm-done` to drain queued
 * mutations + write dirty buffers back.
 */
export interface OpfsRealmMount {
  pyPath: string;
  mount: OpfsMount;
  rootHandle: FileSystemDirectoryHandle;
  flushBuffers: (rootHandle: FileSystemDirectoryHandle) => Promise<void>;
  getDirtyPaths: () => string[];
}

export interface MountedOpfsResult {
  mounts: OpfsRealmMount[];
}

/**
 * Lazily register the in-tree `OPFS_SYNC_FS` plugin on
 * `pyodide.FS.filesystems`. Idempotent — re-mount calls share the
 * single plugin object so node-op identity stays stable across
 * mount points. Emscripten's mount table is keyed on the plugin
 * reference, so re-creating it would shadow the in-flight mounts.
 */
function ensureOpfsSyncFsRegistered(pyodide: PyodideInterface): OpfsSyncFsPlugin {
  const filesystems = (pyodide.FS as unknown as { filesystems: Record<string, unknown> })
    .filesystems;
  let plugin = filesystems.OPFS_SYNC_FS as OpfsSyncFsPlugin | undefined;
  if (!plugin) {
    plugin = createOpfsSyncFs(pyodide.FS as unknown as Parameters<typeof createOpfsSyncFs>[0]);
    filesystems.OPFS_SYNC_FS = plugin;
  }
  return plugin;
}

/**
 * For each `dir`, resolve the same-origin OPFS handle the kernel
 * worker owns (`OPFS-root / <opfsDbName> / <vfsPath…>`), `prewalk`
 * the subtree, then `pyodide.FS.mount(OPFS_SYNC_FS, …, dir)`. The
 * plugin builds the Pyodide-FS tree from the prewalk snapshot
 * synchronously, so Python sees the OPFS contents the instant the
 * mount returns — no `syncfs(true)` round trip needed.
 *
 * Sub-handles are created with `{ create: true }` so a fresh OPFS
 * subtree boots cleanly — `/tmp` and freshly-created cwds don't
 * exist on disk yet but Python expects them to be writable.
 *
 * Write-back relies on the mount's own queued-op chain + buffered
 * provider rather than a Pyodide-FS walk. Per-dir failures (handle
 * resolution, prewalk, mount) surface through `pushWarning` and the
 * loop continues with the next dir.
 */
export async function mountOpfsDirsAndSyncIn(
  pyodide: PyodideInterface,
  dirs: string[],
  opfsDbName: string,
  pushWarning: WarningSink = () => {},
  opts: { skipMountPaths?: ReadonlySet<string> } = {}
): Promise<MountedOpfsResult> {
  const mounts: OpfsRealmMount[] = [];
  const skip = opts.skipMountPaths ?? new Set<string>();
  const storage = (navigator as unknown as { storage?: StorageManager }).storage;
  if (!storage?.getDirectory) {
    pushWarning('VFS→Pyodide OPFS mount skipped: navigator.storage.getDirectory unavailable');
    return { mounts };
  }
  let opfsRoot: FileSystemDirectoryHandle;
  try {
    opfsRoot = await storage.getDirectory();
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount: getDirectory() failed: ${describeRealmError(err)}`);
    return { mounts };
  }
  let kernelDbHandle: FileSystemDirectoryHandle;
  try {
    kernelDbHandle = await opfsRoot.getDirectoryHandle(opfsDbName, { create: true });
  } catch (err) {
    pushWarning(
      `VFS→Pyodide OPFS mount: opening '${opfsDbName}' failed: ${describeRealmError(err)}`
    );
    return { mounts };
  }

  const plugin = ensureOpfsSyncFsRegistered(pyodide);

  for (const dir of dirs) {
    if (dir === '/') {
      await mountRootChildren(pyodide, plugin, kernelDbHandle, skip, mounts, pushWarning);
      continue;
    }
    if (skip.has(dir)) continue;
    try {
      let handle: FileSystemDirectoryHandle = kernelDbHandle;
      for (const part of dir.split('/').filter(Boolean)) {
        handle = await handle.getDirectoryHandle(part, { create: true });
      }
      await mountOpfsChild(pyodide, plugin, dir, handle, mounts);
    } catch (err) {
      pushWarning(`VFS→Pyodide OPFS mount '${dir}' failed: ${describeRealmError(err)}`);
    }
  }

  return { mounts };
}

/**
 * Emscripten rejects `FS.mount(_, _, '/')` with EBUSY because its root
 * MEMFS is already mounted. Fan out to the top-level children of the
 * kernel OPFS subtree instead so Python can still reach the VFS by
 * absolute path (`/workspace`, …) when the shell cwd is `/`. Built-in
 * mount points are skipped so we don't shadow `/dev`, `/proc`, `/lib`,
 * `/tmp`, `/home`.
 */
async function mountRootChildren(
  pyodide: PyodideInterface,
  plugin: OpfsSyncFsPlugin,
  kernelDbHandle: FileSystemDirectoryHandle,
  skip: ReadonlySet<string>,
  mounts: OpfsRealmMount[],
  pushWarning: WarningSink
): Promise<void> {
  try {
    const iter = kernelDbHandle as unknown as AsyncIterable<
      [string, FileSystemDirectoryHandle | FileSystemFileHandle]
    >;
    for await (const [name, childHandle] of iter) {
      if ((childHandle as { kind: string }).kind !== 'directory') continue;
      if (EMSCRIPTEN_BUILTIN_ROOT_DIRS.has(name)) continue;
      const childPath = `/${name}`;
      // Skip OPFS mount when this path is itself a VFS mount —
      // the realm-mount materialization step will mount MEMFS at
      // the same path, and Emscripten cannot stack two mounts on
      // one node.
      if (skip.has(childPath)) continue;
      try {
        await mountOpfsChild(
          pyodide,
          plugin,
          childPath,
          childHandle as FileSystemDirectoryHandle,
          mounts
        );
      } catch (err) {
        pushWarning(`VFS→Pyodide OPFS mount '${childPath}' failed: ${describeRealmError(err)}`);
      }
    }
  } catch (err) {
    pushWarning(`VFS→Pyodide OPFS mount '/' failed: ${describeRealmError(err)}`);
  }
}

/**
 * Shared per-dir mount step: ensure the Pyodide-side directory
 * exists (`mkdirTree`), prewalk the OPFS subtree, hand the plugin
 * an `{ rootHandle, prewalk, sahProvider }` opts object, and record
 * the resulting `OpfsRealmMount` so `flushOpfsRealmMounts` can drain
 * queued ops + dirty buffers at `realm-done`.
 */
async function mountOpfsChild(
  pyodide: PyodideInterface,
  plugin: OpfsSyncFsPlugin,
  pyPath: string,
  handle: FileSystemDirectoryHandle,
  mounts: OpfsRealmMount[]
): Promise<void> {
  try {
    pyodide.FS.stat(pyPath);
  } catch {
    pyodide.FS.mkdirTree(pyPath);
  }
  const prewalk = await prewalkOpfsTree(handle);
  const buffered = createBufferedOpfsSahProvider();
  await buffered.preload(prewalk);
  const opts = { rootHandle: handle, prewalk, sahProvider: buffered.provider };
  const fsMount = pyodide.FS as unknown as {
    mount: (plugin: OpfsSyncFsPlugin, opts: unknown, dir: string) => unknown;
  };
  const rootNode = fsMount.mount(plugin, opts, pyPath) as { mount?: OpfsMount } | undefined;
  const mount =
    rootNode?.mount ??
    ({ opts, mountpoint: pyPath, root: rootNode as never } as unknown as OpfsMount);
  mounts.push({
    pyPath,
    mount,
    rootHandle: handle,
    flushBuffers: buffered.flush,
    getDirtyPaths: buffered.getDirtyPaths,
  });
}

// ---------------------------------------------------------------------------
// OPFS-native write-back (flush queued ops + dirty buffers)
// ---------------------------------------------------------------------------

/**
 * Drain every mount's queued OPFS mutation chain (`mknod`, `unlink`,
 * `rename`, …) then write each buffered SAH's dirty bytes back to
 * the OPFS subtree. Must run before the realm posts `realm-done`
 * so the kernel sees a consistent on-disk view — the plugin's
 * `node_ops` return synchronously after enqueueing async work, and
 * without this flush the kernel can race the still-pending writes.
 *
 * Errors propagate to the caller; `runPyRealm` wraps the call in a
 * `pushWarning` try/catch so a flush failure still emits
 * `realm-done` with the partial output.
 */
export async function flushOpfsRealmMounts(mounts: OpfsRealmMount[]): Promise<void> {
  for (const entry of mounts) {
    await flushPendingOpfsOps(entry.mount);
    await entry.flushBuffers(entry.rootHandle);
  }
}

/**
 * After OPFS flush, tell the kernel VFS to invalidate its in-memory
 * cache for paths Python wrote to. The kernel's `WebAccessFS.stat()`
 * fallback will re-read fresh metadata from OPFS on next access.
 */
async function invalidateDirtyPathsInKernelVfs(
  mounts: OpfsRealmMount[],
  rpc: RealmRpcClient
): Promise<void> {
  const absPaths: string[] = [];
  for (const entry of mounts) {
    for (const relPath of entry.getDirtyPaths()) {
      absPaths.push(entry.pyPath === '/' ? `/${relPath}` : `${entry.pyPath}/${relPath}`);
    }
  }
  if (absPaths.length > 0) {
    await rpc.call('vfs', 'invalidatePaths', [absPaths]);
  }
}
