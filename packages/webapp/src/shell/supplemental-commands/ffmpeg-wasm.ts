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
import { isNodeRuntime } from './shared.js';

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

export const FFMPEG_CORE_NOT_INSTALLED = `@ffmpeg/core is not installed in node_modules: run \`ipk add @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}\` (no network fallback)`;

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
}

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
  ipk: IpkResolutionContext
): Promise<{ coreSource: string; wasmBytes: Uint8Array } | null> {
  let resolved;
  try {
    resolved = await ipkResolve('@ffmpeg/core/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  const corePath = `${pkgDir}/dist/esm/ffmpeg-core.js`;
  const wasmPath = `${pkgDir}/dist/esm/ffmpeg-core.wasm`;
  if (!(await ipk.reader.exists(corePath))) return null;
  if (!(await ipk.reader.exists(wasmPath))) return null;
  try {
    const coreSource = await ipk.reader.readFile(corePath);
    const wasmBytes = await ipk.readBytes(wasmPath);
    return { coreSource, wasmBytes };
  } catch {
    return null;
  }
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
  const loaded = await tryLoadFfmpegCoreFromNodeModules(ipk);
  if (!loaded) throw new Error(FFMPEG_CORE_NOT_INSTALLED);

  log(
    `ffmpeg-core loaded from ipk node_modules (js: ${loaded.coreSource.length} chars, wasm: ${loaded.wasmBytes.byteLength} bytes)`
  );
  const wasmURL = bytesToBlobUrl(loaded.wasmBytes, 'application/wasm');

  // Materialize the core JS source as a blob URL so the
  // `@ffmpeg/ffmpeg` wrapper worker (also `blob:` by default) can
  // `import(coreURL)` same-scheme.
  return {
    coreURL: stringToBlobUrl(loaded.coreSource, 'text/javascript'),
    wasmURL,
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
 * Drop the cached `FFmpeg` instance promise so the next `getFfmpeg`
 * call rebuilds from scratch. Test-only — production callers share
 * the single loaded instance for the lifetime of the realm.
 */
export function resetFfmpegForTests(): void {
  ffmpegPromise = null;
}
