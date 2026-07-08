/**
 * Shared ImageMagick WASM initialization module.
 *
 * Extracted from convert-command.ts so both `convert` and `image-processor`
 * can reuse the same cached WASM instance. Handles dual-mode loading:
 * - Extension: bundled magick.wasm via chrome.runtime.getURL
 * - Node (vitest): local node_modules via `import.meta.url`
 * - Browser (CLI, incl. DedicatedWorker): ipk-installed
 *   `@imagemagick/magick-wasm` in the VFS `node_modules` (read via the
 *   shared `IpkResolutionContext` — same shape esbuild-wasm.ts uses).
 *   There is no CDN fallback: if nothing is installed, the browser path
 *   throws a clean guidance error and `convert` / `magick` surface it
 *   verbatim. Non-shell callers (image-processor, browser-api) have
 *   their own try/catch fallbacks and degrade gracefully when no
 *   shell-side caller has populated the cached promise yet.
 *
 * Detect Node via `process.versions.node` — `typeof window === 'undefined'`
 * also matches DedicatedWorkers, which still need the browser path.
 *
 * The `@imagemagick/magick-wasm` JS glue is imported STATICALLY (like
 * `@ffmpeg/ffmpeg` in `ffmpeg-wasm.ts`) — NOT via a dynamic
 * `import()`. A dynamic import is delivered as a separate Rollup chunk
 * wrapped in Vite's `__vitePreload` helper; inside the kernel
 * DedicatedWorker (no `document` / `window`) that production code path
 * never settles and wedges the worker, so `convert` / `magick` hang on
 * every real operation. `optimizeDeps.include` only papered over this
 * in dev (single prebundled module); the static import is what makes
 * the production `vite build` worker bundle resolve the glue inline.
 * Only the heavy `magick.wasm` binary stays out of the bundle — it is
 * loaded from the VFS ipk install (or the extension's bundled copy).
 */

import * as magickModule from '@imagemagick/magick-wasm';
import { isExtensionRealm } from '../../core/runtime-env.js';
import { splitPath } from '../../fs/path-utils.js';
import { compileWasmModule } from '../../kernel/realm/wasm-compiler.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { isNodeRuntime } from './shared.js';

export interface ImageMagickModule {
  initializeImageMagick: (wasmLocation: URL | Uint8Array | WebAssembly.Module) => Promise<void>;
  ImageMagick: {
    read: (data: Uint8Array, callback: (image: IMagickImage) => Promise<void>) => Promise<void>;
  };
  MagickFormat: Record<string, string>;
  MagickGeometry: {
    new (value: string): IMagickGeometry;
    new (widthAndHeight: number): IMagickGeometry;
    new (width: number, height: number): IMagickGeometry;
  };
  Percentage: new (value: number) => { toDouble(): number };
}

export interface IMagickGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
  isPercentage: boolean;
  ignoreAspectRatio: boolean;
}

export interface IMagickImage {
  resize(width: number, height: number): void;
  resize(geometry: IMagickGeometry): void;
  rotate(degrees: number): void;
  crop(geometry: IMagickGeometry): void;
  crop(width: number, height: number): void;
  quality: number;
  width: number;
  height: number;
  write(format: string, callback: (data: Uint8Array) => void): void;
  write(callback: (data: Uint8Array) => void): void;
}

/** MIME type to ImageMagick format string mapping. Single source of truth. */
export const MIME_TO_MAGICK_FORMAT: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
  'image/avif': 'AVIF',
};

/**
 * Read-only VFS context the loader needs to read an ipk-installed
 * `@imagemagick/magick-wasm/dist/magick.wasm`. Shape-identical to
 * `IpkResolutionContext` in `esbuild-wasm.ts` so any command can build
 * one context and pass it to either loader. `readBytes` reads the
 * resolved `.wasm` as raw bytes; `fromDir` is the starting directory
 * for the `node_modules` walk — typically the shell `cwd` of the
 * calling command.
 */
export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

/**
 * The `@imagemagick/magick-wasm` release whose JS glue is statically
 * bundled into this build (the `import * as magickModule` above resolves
 * the host `node_modules` copy at build time). The Emscripten glue and the
 * runtime `magick.wasm` MUST be the same version: handing the bundled glue
 * a `magick.wasm` from a different release makes `initializeImageMagick`
 * hang forever in the kernel DedicatedWorker — the glue reads exports the
 * mismatched binary lays out differently, so an emscripten run dependency
 * is never fulfilled and the bring-up never settles (it then trips
 * `withInitTimeout` after 30s). This is exactly why `convert` hung in
 * production: a bare `ipk add @imagemagick/magick-wasm` installs npm-latest
 * into the VFS, so a newer `magick.wasm` was fed to the older glue. The
 * browser loader guards against the mismatch (`assertMagickVersionMatch`)
 * and the install guidance pins this exact version.
 *
 * The version is baked from `packages/webapp/package.json` via the Vite /
 * vitest `__MAGICK_WASM_VERSION__` define (range-prefix stripped) — for a
 * `0.0.x` caret range npm locks to exactly that version, which is what the
 * bundled glue resolves to. Deriving it from the manifest means Renovate
 * bumping the dependency automatically updates the install guidance and the
 * version guard with no source literal to drift; a unit test keeps the
 * injected value in lockstep with the actually-installed package.
 */
export const BUNDLED_MAGICK_VERSION = __MAGICK_WASM_VERSION__;

const MAGICK_NOT_INSTALLED = `@imagemagick/magick-wasm is not installed in node_modules: run \`ipk add @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}\` (no network fallback)`;

/**
 * Build the actionable error surfaced when the ipk-installed
 * `@imagemagick/magick-wasm` is a different version than the bundled JS
 * glue. Pins the exact version to re-install so the user resolves the
 * silent-hang root cause in one step instead of debugging a wedged worker.
 */
function magickVersionMismatchError(installed: string): Error {
  return new Error(
    `@imagemagick/magick-wasm version mismatch: the bundled JS glue is ` +
      `${BUNDLED_MAGICK_VERSION} but ${installed} is installed in node_modules. ` +
      `The Emscripten glue and magick.wasm must be the same version or ` +
      `initializeImageMagick hangs in the kernel worker. Run ` +
      `\`ipk add @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}\` to install the matching version.`
  );
}

/**
 * Throw if the ipk-installed `magick.wasm` version does not match the
 * bundled glue. Exported so the version-compatibility contract is
 * unit-testable without booting the heavy WASM service (vitest runs the
 * Node branch, which never reaches the browser guard).
 */
export function assertMagickVersionMatch(installedVersion: string): void {
  if (installedVersion !== BUNDLED_MAGICK_VERSION) {
    throw magickVersionMismatchError(installedVersion);
  }
}

/**
 * Upper bound on a single `initializeImageMagick` call. The compile step
 * already runs separately (host-side `compileWasmModule`), so a
 * Module-backed init only does emscripten's synchronous
 * `new WebAssembly.Instance(...)` bring-up — well under a second in
 * practice. The bound turns the historical "hangs forever in the kernel
 * worker on every real op" failure into a clean, surfaced error instead
 * of a wedged worker.
 */
export const MAGICK_INIT_TIMEOUT_MS = 30_000;

/**
 * Race `initializeImageMagick` against a bounded timer so a wedged WASM
 * bring-up surfaces a clear error rather than hanging the kernel worker
 * indefinitely. The timer is always cleared on settle; the init promise
 * gets a no-op catch so a late rejection after a timeout win can't become
 * an unhandled rejection.
 */
export async function withInitTimeout<T>(
  init: Promise<T>,
  timeoutMs: number = MAGICK_INIT_TIMEOUT_MS
): Promise<T> {
  init.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`ImageMagick WASM initialization timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([init, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let magickPromise: Promise<ImageMagickModule> | null = null;
export const isExtension = isExtensionRealm();

/**
 * Public entry point. Idempotent across calls within a session — the
 * loader memoizes the underlying promise and re-throws the same
 * failure if init was rejected (a fresh import would still reject).
 *
 * In Node / vitest, `ipk` is unused (the WASM binary is resolved from
 * the locally-installed npm package via `import.meta.url`). In the
 * Chrome extension, `ipk` is unused (the WASM is bundled and fetched
 * via `chrome.runtime.getURL`). In every other browser runtime
 * (standalone CLI, hosted-leader cloud sandbox, kernel worker, …),
 * `ipk` is REQUIRED to locate `magick.wasm` in the VFS `node_modules`;
 * calls without an ipk context, or with one that finds nothing
 * installed, throw the canonical `ipk add @imagemagick/magick-wasm`
 * guidance error.
 */
export async function getMagick(
  options: { ipk?: IpkResolutionContext } = {}
): Promise<ImageMagickModule> {
  if (!magickPromise) {
    magickPromise = loadMagick(options.ipk).catch((err) => {
      magickPromise = null;
      throw err;
    });
  }
  return magickPromise;
}

async function loadMagick(ipk?: IpkResolutionContext): Promise<ImageMagickModule> {
  if (isExtension) {
    // Chrome extension — fetch bundled WASM as bytes, then compile to a
    // `WebAssembly.Module` host-side (the offscreen document, not a
    // per-task realm worker). Passing the compiled module makes
    // `initializeImageMagick` take emscripten's synchronous
    // `instantiateWasm` path (`new WebAssembly.Instance(module, imports)`)
    // instead of the async byte path (`wasmBinary` →
    // `WebAssembly.instantiate(bytes)`) that wedges in a DedicatedWorker.
    // initializeImageMagick rejects chrome-extension:// URLs, so this also
    // avoids the URL branch.
    const wasmUrl = chrome.runtime.getURL('magick.wasm');
    const resp = await fetch(wasmUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch magick.wasm: ${resp.status} ${resp.statusText}`);
    }
    const wasmBytes = new Uint8Array(await resp.arrayBuffer());
    const wasmModule = await compileWasmModule(wasmBytes);
    await withInitTimeout(magickModule.initializeImageMagick(wasmModule));
    return magickModule as unknown as ImageMagickModule;
  }
  if (isNodeRuntime()) {
    // Node / vitest — resolve the locally-installed npm package's
    // `magick.wasm` via `import.meta.url`. No network, no ipk required.
    // The Node entry loads + instantiates the URL itself; there is no
    // kernel worker to wedge, so no host-side compile step is needed.
    const wasmBase = new URL(
      '../../../../../node_modules/@imagemagick/magick-wasm/dist/',
      import.meta.url
    ).toString();
    const wasmUrl = new URL('magick.wasm', wasmBase);
    await withInitTimeout(magickModule.initializeImageMagick(wasmUrl));
    return magickModule as unknown as ImageMagickModule;
  }
  // Browser (standalone OR any non-extension browser realm): an
  // ipk-installed copy of `@imagemagick/magick-wasm/dist/magick.wasm`
  // in the VFS `node_modules` is the only supported source. Without
  // it, surface a clean error rather than reaching out to the network.
  if (!ipk) throw new Error(MAGICK_NOT_INSTALLED);
  const installed = await tryLoadMagickWasmFromNodeModules(ipk);
  if (!installed) throw new Error(MAGICK_NOT_INSTALLED);
  // Guard the glue/wasm version contract BEFORE compiling: an ipk-installed
  // `magick.wasm` from a different release than the bundled glue makes
  // emscripten's `initializeImageMagick` hang forever in the kernel worker
  // (a run dependency is never fulfilled). Fail fast with actionable
  // guidance instead of waiting out the 30s timeout on every real op.
  assertMagickVersionMatch(installed.version);
  const bytes = installed.bytes;
  // Compile the bytes to a `WebAssembly.Module` in this (high-headroom
  // kernel-worker / shell) context — the same host-side primitive the
  // realm-host `wasm` channel and the esbuild loader use. Handing the
  // compiled module to `initializeImageMagick` forces magick-wasm's
  // synchronous `new WebAssembly.Instance(module, imports)` bring-up,
  // which avoids the async byte-instantiation that hangs the kernel
  // worker on every real convert/magick op. `compileWasmModule` honors
  // the view's byteOffset/byteLength and sidesteps the
  // `SharedArrayBuffer | ArrayBuffer` typing union, so no buffer copy is
  // needed first.
  const wasmModule = await compileWasmModule(bytes);
  await withInitTimeout(magickModule.initializeImageMagick(wasmModule));
  return magickModule as unknown as ImageMagickModule;
}

/**
 * Try to read `@imagemagick/magick-wasm/dist/magick.wasm` from an
 * ipk-installed package in the VFS. Resolves
 * `@imagemagick/magick-wasm/package.json` through the shared resolver
 * (so the standard `node_modules` walk and resolution rules apply),
 * derives the package directory from the resolved file, reads the
 * package's `version` (for the glue/wasm compatibility guard), and reads
 * `dist/magick.wasm` bytes. Returns `null` on any miss — the caller
 * surfaces the canonical guidance error. The `version` is `'unknown'`
 * only if the resolved `package.json` can't be read/parsed; the caller's
 * mismatch guard then surfaces that verbatim.
 *
 * Exported so the loader's resolution behavior is unit-testable
 * without booting the heavy WASM service.
 */
export async function tryLoadMagickWasmFromNodeModules(
  ipk: IpkResolutionContext
): Promise<{ bytes: Uint8Array; version: string } | null> {
  let resolved;
  try {
    resolved = await ipkResolve('@imagemagick/magick-wasm/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  const wasmPath = `${pkgDir}/dist/magick.wasm`;
  if (!(await ipk.reader.exists(wasmPath))) return null;
  let version = 'unknown';
  try {
    const pkg = JSON.parse(new TextDecoder().decode(await ipk.readBytes(resolved.path)));
    if (typeof pkg?.version === 'string') version = pkg.version;
  } catch {
    // Leave version as 'unknown'; the mismatch guard surfaces it.
  }
  try {
    return { bytes: await ipk.readBytes(wasmPath), version };
  } catch {
    return null;
  }
}

/**
 * Drop the cached magick promise so the next `getMagick` call rebuilds
 * from scratch. Test-only — production callers share the single loaded
 * instance for the lifetime of the realm.
 */
export function resetMagickForTests(): void {
  magickPromise = null;
}
