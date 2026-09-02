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
 * Read-only VFS context the loader needs to read an ipk-installed
 * `@ffmpeg/core/dist/esm/{ffmpeg-core.js,ffmpeg-core.wasm}` pair.
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

let ffmpegPromise: Promise<FFmpeg> | null = null;

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
  log('initializing ffmpeg-core...');
  await ffmpeg.load({
    coreURL: assets.coreURL,
    wasmURL: assets.wasmURL,
    ...(assets.workerURL ? { workerURL: assets.workerURL } : {}),
    ...(assets.classWorkerURL ? { classWorkerURL: assets.classWorkerURL } : {}),
  });
  log('ffmpeg ready');
  return ffmpeg;
}

/**
 * Try to read `@ffmpeg/core`'s `dist/esm/ffmpeg-core.{js,wasm}` from
 * an ipk-installed `@ffmpeg/core` in the VFS. Resolves
 * `@ffmpeg/core/package.json` through the shared resolver (so the
 * standard `node_modules` walk and resolution rules apply), derives
 * the package directory from the resolved file, and reads the
 * sibling JS source + wasm bytes. Returns `null` on any resolution
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
    return selectFfmpegCore(ipk, globalThis.crossOriginIsolated === true);
  }
  let resolved;
  try {
    resolved = await ipkResolve(`${pkg}/package.json`, ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  const corePath = `${pkgDir}/dist/esm/ffmpeg-core.js`;
  const wasmPath = `${pkgDir}/dist/esm/ffmpeg-core.wasm`;
  // The -mt core is unusable without its pthread worker — treat a missing
  // worker file as not-installed rather than booting a broken core.
  const workerPath =
    pkg === FFMPEG_CORE_MT_PACKAGE ? `${pkgDir}/dist/esm/ffmpeg-core.worker.js` : null;
  if (!(await ipk.reader.exists(corePath))) return null;
  if (!(await ipk.reader.exists(wasmPath))) return null;
  if (workerPath && !(await ipk.reader.exists(workerPath))) return null;
  try {
    const coreSource = await ipk.reader.readFile(corePath);
    const wasmBytes = await ipk.readBytes(wasmPath);
    const workerSource = workerPath ? await ipk.reader.readFile(workerPath) : undefined;
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
  if (!ipk) throw new Error(FFMPEG_CORE_NOT_INSTALLED);
  const loaded = await selectFfmpegCore(ipk, globalThis.crossOriginIsolated === true);
  if (!loaded) throw new Error(FFMPEG_CORE_NOT_INSTALLED);

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
export function recycleFfmpeg(): void {
  const stale = ffmpegPromise;
  ffmpegPromise = null;
  if (!stale) return;
  // Settle out-of-band: the promise may still be pending, and a
  // rejected one must not resurface here as an unhandled rejection.
  void stale.then(
    (ffmpeg) => {
      try {
        ffmpeg.terminate();
      } catch {
        /* worker already gone */
      }
    },
    () => {
      /* load failed — there is no worker to terminate */
    }
  );
}

/**
 * Drop the cached `FFmpeg` instance promise without touching the
 * worker. Test-only — production recycling goes through
 * {@link recycleFfmpeg}.
 */
export function resetFfmpegForTests(): void {
  ffmpegPromise = null;
}
