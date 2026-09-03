/**
 * Shared ffmpeg-wasm loader. The small `@ffmpeg/ffmpeg` JS wrapper
 * is statically bundled; the heavy `@ffmpeg/core` artifacts
 * (`ffmpeg-core.js` + `ffmpeg-core.wasm`, ~31 MB combined) are
 * intentionally NOT bundled and must be installed by the user via
 * `ipk add @ffmpeg/core@<version>` (the version pinned in
 * `packages/webapp/package.json`). There is no CDN fallback — uninstalled
 * calls throw the canonical guidance error which the calling
 * command surfaces verbatim. ZERO network in the not-installed
 * path. Mirrors the install-required loader pattern used by
 * `esbuild-wasm.ts`, `biome-command.ts`, and `getTypeScript()` in
 * `shared.ts`.
 *
 * Both the core JS glue and the wasm binary come from the ipk-installed
 * `@ffmpeg/core` package in the VFS `node_modules`; both are materialized as
 * `blob:` URLs so the `@ffmpeg/ffmpeg` wrapper worker (also `blob:` by default)
 * can `import(coreURL)` same-scheme. In the thin extension this runs in the
 * hosted leader tab's worker (a normal `sliccy.ai` origin), not the extension
 * origin — the old vendored `dist/extension/vendor/` copies were removed.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { splitPath } from '../../fs/path-utils.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { GLOBAL_IPK_ADD, isNodeRuntime } from './shared.js';

/**
 * The `@ffmpeg/core` release whose `ffmpeg-core.{js,wasm}` artifacts pair
 * with the statically-bundled `@ffmpeg/ffmpeg` wrapper. Baked from
 * `packages/webapp/package.json` via the Vite / vitest
 * `__FFMPEG_CORE_VERSION__` define (range-prefix stripped) so the install
 * guidance pins an exact version. Deriving it from the manifest means
 * Renovate bumping the dependency automatically updates the guidance — no
 * source literal to drift, mirroring `magick-wasm.ts` and `biome-command.ts`.
 */
export const BUNDLED_FFMPEG_CORE_VERSION = __FFMPEG_CORE_VERSION__;

export const FFMPEG_CORE_NOT_INSTALLED = `@ffmpeg/core is not installed in node_modules: run \`${GLOBAL_IPK_ADD} @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}\` (no network fallback)`;

/**
 * The multi-threaded core (pthreads over SharedArrayBuffer). Preferred
 * automatically when the runtime is cross-origin isolated (the leader is,
 * via Document-Isolation-Policy — see #2040) AND the package is installed;
 * `@ffmpeg/core` remains the universal fallback because embedded floats
 * (Cherry, spoon/Electron) can never be isolated. Published in lockstep
 * with `@ffmpeg/core`, so the same pinned version applies.
 */
export const FFMPEG_CORE_MT_PACKAGE = '@ffmpeg/core-mt';

/**
 * Install guidance for an isolated runtime, where the multi-threaded core
 * is the one worth installing. Kept separate from
 * {@link FFMPEG_CORE_NOT_INSTALLED} so a non-isolated float (Cherry,
 * Electron, older Chrome) is never told to install a core it cannot boot.
 */
export const FFMPEG_CORE_MT_NOT_INSTALLED = `no ffmpeg core is installed in node_modules: this runtime is cross-origin isolated, so run \`${GLOBAL_IPK_ADD} ${FFMPEG_CORE_MT_PACKAGE}@${BUNDLED_FFMPEG_CORE_VERSION}\` for the multi-threaded core (\`${GLOBAL_IPK_ADD} @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}\` is the single-threaded fallback; no network fallback)`;

/** `true` when this realm has SharedArrayBuffer and can run pthreads. */
export function isCrossOriginIsolated(): boolean {
  return globalThis.crossOriginIsolated === true;
}

/**
 * The not-installed message that fits the calling runtime. Every surface
 * that reports a missing core (`ffmpeg`, `ffprobe`, the loader) goes
 * through here so the guidance an agent copies is the core the loader
 * would actually prefer — see {@link selectFfmpegCore}.
 */
export function ffmpegCoreNotInstalledMessage(isolated = isCrossOriginIsolated()): string {
  return isolated ? FFMPEG_CORE_MT_NOT_INSTALLED : FFMPEG_CORE_NOT_INSTALLED;
}

/**
 * One-line description of a resolved core for `-version` output: which
 * package, threaded or not, and — when a faster core is one `ipk add`
 * away — what to install. Exported for unit tests.
 */
export function describeFfmpegCore(
  loaded: Pick<LoadedFfmpegCore, 'pkg'>,
  isolated = isCrossOriginIsolated(),
  cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined
): string {
  const version = `${loaded.pkg} ${BUNDLED_FFMPEG_CORE_VERSION}`;
  if (loaded.pkg === FFMPEG_CORE_MT_PACKAGE) {
    const threads = typeof cores === 'number' && cores > 0 ? `, ${cores} threads` : '';
    return `${version} (multi-threaded${threads})`;
  }
  if (isolated) {
    return `${version} (single-threaded; this runtime is cross-origin isolated, run \`${GLOBAL_IPK_ADD} ${FFMPEG_CORE_MT_PACKAGE}@${BUNDLED_FFMPEG_CORE_VERSION}\` for multi-threading)`;
  }
  return `${version} (single-threaded; runtime is not cross-origin isolated)`;
}

/**
 * Read-only VFS context the loader needs to read an ipk-installed
 * `@ffmpeg/core` glue + wasm pair (see {@link FFMPEG_CORE_LAYOUTS} for
 * where inside the package they live).
 * Mirrors the {@link IpkResolutionContext} shape used by
 * `esbuild-wasm.ts` and `biome-command.ts` so every float
 * (standalone/hosted/extension/Node) wires the loader the same way.
 * `reader` is the resolver's `ModuleReader` (used to find the
 * package via the standard `node_modules` walk); `readBytes` reads
 * the resolved `.wasm` as raw bytes (the resolver's `readFile` is
 * text-only). `fromDir` is the starting directory for the walk —
 * typically the shell `cwd` of the calling command.
 */
export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

interface FfmpegAssetUrls {
  coreURL: string;
  wasmURL: string;
  classWorkerURL?: string;
  /** Pthread worker (multi-threaded core only). */
  workerURL?: string;
}

/** A core package resolved from the VFS `node_modules`. */
export interface LoadedFfmpegCore {
  pkg: typeof FFMPEG_CORE_PACKAGE | typeof FFMPEG_CORE_MT_PACKAGE;
  coreSource: string;
  wasmBytes: Uint8Array;
  /** `ffmpeg-core.worker.js` source — present only for the `-mt` core. */
  workerSource?: string;
}

const FFMPEG_CORE_PACKAGE = '@ffmpeg/core';

/**
 * Directories inside an ipk-installed core package that hold the
 * `ffmpeg-core.{js,wasm}` pair (plus `ffmpeg-core.worker.js` for the -mt
 * core), relative to the package root, newest layout first. The first
 * layout whose required files all exist wins.
 *
 * Verified against the registry with `npm pack`, not assumed: every 0.12.x
 * release from 0.12.0 through the pinned 0.12.10 ships the identical
 * `dist/esm/` + `dist/umd/` pair, for `@ffmpeg/core` and `@ffmpeg/core-mt`
 * alike. So there is exactly one supported layout today. The list exists
 * so the next reorganisation is a one-line change here, with
 * `ffmpeg-wasm-live.test.ts` (which resolves the REAL installed package)
 * failing to say so — instead of the silent "not installed" that the
 * magick 0.0.43 bump produced (PR #2744) while every filesystem-mocking
 * test stayed green.
 *
 * Two layouts that HAVE shipped are deliberately not candidates:
 *
 * - `dist/umd/` (0.12.x, the package's `main`). The `@ffmpeg/ffmpeg`
 *   wrapper always spawns a module worker, whose `importScripts` throws, so
 *   it loads the glue with `(await import(coreURL)).default`. The UMD build
 *   has no default export (it assigns `module.exports` / `define`), so the
 *   wrapper would throw its import-failure error from inside the worker —
 *   worse than the clean install guidance the caller surfaces on `null`.
 * - flat `dist/` (0.11.x and earlier: `dist/ffmpeg-core.{js,wasm,worker.js}`).
 *   That core speaks the pre-0.12 `createFFmpeg` protocol and cannot be
 *   driven by the bundled 0.12 wrapper at all; an `ipk add @ffmpeg/core@0.11`
 *   is a version mismatch, not a layout the loader should paper over.
 */
const FFMPEG_CORE_LAYOUTS = ['dist/esm'] as const;

/** Absolute VFS paths of one core install's files, resolved against one layout. */
interface FfmpegCoreFiles {
  core: string;
  wasm: string;
  /** Pthread worker — required for (and only present with) the -mt core. */
  worker: string | null;
}

/**
 * First layout under `pkgDir` whose glue + wasm (+ pthread worker for the
 * -mt core) all exist, or null when none does — a partial/pruned install
 * or a layout this loader does not know. The -mt core is unusable without
 * its worker, so a layout missing it is a miss rather than a broken boot.
 */
async function findFfmpegCoreFiles(
  pkgDir: string,
  pkg: LoadedFfmpegCore['pkg'],
  reader: ModuleReader
): Promise<FfmpegCoreFiles | null> {
  for (const layout of FFMPEG_CORE_LAYOUTS) {
    const dir = `${pkgDir}/${layout}`;
    const files: FfmpegCoreFiles = {
      core: `${dir}/ffmpeg-core.js`,
      wasm: `${dir}/ffmpeg-core.wasm`,
      worker: pkg === FFMPEG_CORE_MT_PACKAGE ? `${dir}/ffmpeg-core.worker.js` : null,
    };
    if (!(await reader.exists(files.core))) continue;
    if (!(await reader.exists(files.wasm))) continue;
    if (files.worker && !(await reader.exists(files.worker))) continue;
    return files;
  }
  return null;
}

let ffmpegPromise: Promise<FFmpeg> | null = null;

/**
 * The instance {@link ffmpegPromise} currently resolves to, tracked
 * separately so {@link recycleFfmpeg} can identify the *generation*
 * being retired without awaiting. `null` while a load is in flight.
 */
let currentFfmpeg: FFmpeg | null = null;

/**
 * `blob:` URLs backing the loaded core (~31 MB of JS + wasm, plus the
 * pthread worker for `-mt`). Terminating the wrapper worker does not
 * revoke them, so a recycled generation would pin its assets until the
 * tab closed — feeding the very memory pressure that forced the
 * recycle. Retired alongside the instance.
 */
let currentAssetUrls: string[] = [];

function revokeAssetUrls(urls: string[]): void {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* no URL registry in this realm */
    }
  }
}

/**
 * Public entry point. Idempotent across calls within a session —
 * the loaded `FFmpeg` instance is shared. Subsequent `ffmpeg`
 * invocations reuse the same wasm-backed worker.
 *
 * Browser runtime (standalone OR extension): `ipk` is required to
 * locate the `@ffmpeg/core` assets in VFS `node_modules`. Calls
 * without an ipk context, or with one that finds nothing installed,
 * throw {@link FFMPEG_CORE_NOT_INSTALLED}.
 */
export async function getFfmpeg(
  options: { onProgress?: (msg: string) => void; ipk?: IpkResolutionContext } = {}
): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = loadFfmpeg(options.onProgress, options.ipk).catch((err) => {
      // Reset on failure so the next call retries from scratch.
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

async function loadFfmpeg(
  onProgress?: (msg: string) => void,
  ipk?: IpkResolutionContext
): Promise<FFmpeg> {
  const log = onProgress ?? (() => {});
  const ffmpeg = new FFmpeg();
  const assets = await resolveAssetUrls(ipk, log);
  const urls = [assets.coreURL, assets.wasmURL, assets.workerURL, assets.classWorkerURL].filter(
    (u): u is string => typeof u === 'string'
  );
  log('initializing ffmpeg-core...');
  try {
    await ffmpeg.load({
      coreURL: assets.coreURL,
      wasmURL: assets.wasmURL,
      ...(assets.workerURL ? { workerURL: assets.workerURL } : {}),
      ...(assets.classWorkerURL ? { classWorkerURL: assets.classWorkerURL } : {}),
    });
  } catch (err) {
    // A core that never booted still allocated its blob URLs.
    revokeAssetUrls(urls);
    throw err;
  }
  log('ffmpeg ready');
  currentFfmpeg = ffmpeg;
  currentAssetUrls = urls;
  return ffmpeg;
}

/**
 * Try to read `@ffmpeg/core`'s `ffmpeg-core.{js,wasm}` from an
 * ipk-installed `@ffmpeg/core` in the VFS. Resolves
 * `@ffmpeg/core/package.json` through the shared resolver (so the
 * standard `node_modules` walk and resolution rules apply), derives
 * the package directory from the resolved file, locates the glue + wasm
 * in a supported layout (see `FFMPEG_CORE_LAYOUTS`), and reads the JS
 * source + wasm bytes. Returns `null` on any resolution
 * / read miss so the caller surfaces the canonical guidance error.
 * Exported so the loader's resolution behavior is unit-testable
 * without booting the heavy wasm runtime.
 */
export async function tryLoadFfmpegCoreFromNodeModules(
  ipk: IpkResolutionContext,
  pkg?: LoadedFfmpegCore['pkg']
): Promise<LoadedFfmpegCore | null> {
  // No explicit package → isolation-aware selection. The `ffmpeg -version`
  // gate calls this no-arg form, so an isolated leader with only the -mt
  // core installed reports ready instead of "not installed". (The gate
  // lives in ffmpeg-command.ts, which is layer-back-edge debt-listed —
  // the fix belongs here so that file stays untouched.)
  if (pkg === undefined) {
    return selectFfmpegCore(ipk, isCrossOriginIsolated());
  }
  let resolved;
  try {
    resolved = await ipkResolve(`${pkg}/package.json`, ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const files = await findFfmpegCoreFiles(splitPath(resolved.path).dir, pkg, ipk.reader);
  if (!files) return null;
  try {
    const coreSource = await ipk.reader.readFile(files.core);
    const wasmBytes = await ipk.readBytes(files.wasm);
    const workerSource = files.worker ? await ipk.reader.readFile(files.worker) : undefined;
    return { pkg, coreSource, wasmBytes, ...(workerSource !== undefined ? { workerSource } : {}) };
  } catch {
    return null;
  }
}

/**
 * Pick the core to boot: the multi-threaded `@ffmpeg/core-mt` when the
 * runtime is cross-origin isolated (SharedArrayBuffer available for its
 * pthread pool) and the package is installed; otherwise the single-threaded
 * `@ffmpeg/core`. Exported for unit tests; production passes
 * `globalThis.crossOriginIsolated`.
 */
export async function selectFfmpegCore(
  ipk: IpkResolutionContext,
  isolated: boolean
): Promise<LoadedFfmpegCore | null> {
  if (isolated) {
    const mt = await tryLoadFfmpegCoreFromNodeModules(ipk, FFMPEG_CORE_MT_PACKAGE);
    if (mt) return mt;
  }
  // Explicit package — the no-arg form of tryLoad delegates HERE, so the
  // fallback must never itself be the no-arg form (infinite recursion).
  return tryLoadFfmpegCoreFromNodeModules(ipk, FFMPEG_CORE_PACKAGE);
}

async function resolveAssetUrls(
  ipk: IpkResolutionContext | undefined,
  log: (msg: string) => void
): Promise<FfmpegAssetUrls> {
  if (isNodeRuntime()) {
    // Node / vitest don't run the wasm core — every code path that
    // would call into the loader short-circuits before reaching here
    // (the avfoundation capture branch needs a browser realm). Surface
    // a clear error if a caller still tries.
    throw new Error('ffmpeg-wasm is not available in Node runtime');
  }
  if (!ipk) throw new Error(ffmpegCoreNotInstalledMessage());
  const loaded = await selectFfmpegCore(ipk, isCrossOriginIsolated());
  if (!loaded) throw new Error(ffmpegCoreNotInstalledMessage());

  log(
    `${loaded.pkg} loaded from ipk node_modules (js: ${loaded.coreSource.length} chars, wasm: ${loaded.wasmBytes.byteLength} bytes${loaded.workerSource ? ', multi-threaded' : ''})`
  );
  const wasmURL = bytesToBlobUrl(loaded.wasmBytes, 'application/wasm');

  // Materialize the core JS source as a blob URL so the
  // `@ffmpeg/ffmpeg` wrapper worker (also `blob:` by default) can
  // `import(coreURL)` same-scheme. The -mt pthread worker rides the same
  // pattern (the official multithread recipe uses blob URLs for all three).
  return {
    coreURL: stringToBlobUrl(loaded.coreSource, 'text/javascript'),
    wasmURL,
    ...(loaded.workerSource !== undefined
      ? { workerURL: stringToBlobUrl(loaded.workerSource, 'text/javascript') }
      : {}),
  };
}

function bytesToBlobUrl(bytes: Uint8Array, contentType: string): string {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return URL.createObjectURL(new Blob([buffer], { type: contentType }));
}

function stringToBlobUrl(source: string, contentType: string): string {
  return URL.createObjectURL(new Blob([source], { type: contentType }));
}

/**
 * True when an error out of the core is unrecoverable for the
 * *instance*, not merely for the call: a WebAssembly trap, an
 * emscripten abort, or an allocation the runtime could not satisfy.
 * All of them leave linear memory inconsistent, so the instance has
 * to be retired via {@link recycleFfmpeg} instead of reused.
 *
 * Single home for both `ffmpeg` and `ffprobe` — the predicate was
 * derived from a live production trap (`RangeError: Array buffer
 * allocation failed` at ~1.89 GB) and will be widened again; two
 * copies would let one silently diverge and leave a poisoned core
 * cached for later commands.
 */
export function isCoreFault(err: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) return true;
  if (err instanceof RangeError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /RuntimeError|memory access out of bounds|unreachable|Aborted|out of memory|allocation failed|table index is out of bounds|function signature mismatch/i.test(
    message
  );
}

/**
 * Drop the cached instance after an unrecoverable fault so the next
 * `getFfmpeg` boots a fresh core.
 *
 * A WebAssembly trap (`RuntimeError: memory access out of bounds`,
 * `unreachable`, an emscripten `Aborted(…)`) is terminal for the
 * *instance*, not just the call that hit it — linear memory is left
 * inconsistent and every later entry re-traps immediately. Because
 * {@link ffmpegPromise} is realm-scoped, one trap used to poison
 * `ffmpeg` for the lifetime of the tab: after a 10 MB remux blew the
 * heap, a 64x64 `lavfi` encode with no inputs at all failed with the
 * identical trap. Recycling makes a fault cost one command instead
 * of the whole session.
 *
 * `terminate()` is what actually reclaims the dead core's heap; the
 * `catch` above in {@link getFfmpeg} only covers a *load* failure,
 * which never produced an instance to begin with.
 */
export function recycleFfmpeg(faulted?: FFmpeg): void {
  // Retire only the generation that actually faulted. Shell runs share
  // the cached core, so a slow run can unwind from an instance that a
  // faster retry has already replaced — without this guard it would
  // terminate the healthy core the retry just booted. A `null`
  // `currentFfmpeg` means a fresh load is in flight, which by
  // definition is not the instance that faulted.
  if (faulted !== undefined && currentFfmpeg !== faulted) return;

  const stale = currentFfmpeg;
  const staleUrls = currentAssetUrls;
  ffmpegPromise = null;
  currentFfmpeg = null;
  currentAssetUrls = [];

  if (stale) {
    try {
      stale.terminate();
    } catch {
      /* worker already gone */
    }
  }
  revokeAssetUrls(staleUrls);
}

/**
 * Drop the cached `FFmpeg` instance promise without touching the
 * worker. Test-only — production recycling goes through
 * {@link recycleFfmpeg}.
 */
export function resetFfmpegForTests(): void {
  ffmpegPromise = null;
  currentFfmpeg = null;
  currentAssetUrls = [];
}
