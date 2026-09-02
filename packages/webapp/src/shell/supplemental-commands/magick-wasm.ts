/**
 * Shared ImageMagick WASM initialization module.
 *
 * Extracted from convert-command.ts so both `convert` and `image-processor`
 * can reuse the same cached WASM instance. Loads:
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
 * loaded from the VFS ipk install.
 *
 * The glue is imported by NAMED BINDING, never as `import * as ns`. That
 * is a bundle-size contract, not style: since 0.0.43 the package ships the
 * Emscripten glue for BOTH memory models in one module — `x86/magick.js`
 * (~124 kB) behind `initializeImageMagick` and `x64/magick.js` (~130 kB)
 * behind `initializeImageMagickx64`. A namespace import references every
 * export, so Rollup must retain both and the unused 64-bit glue rides
 * along. Because this module sits in the kernel worker's EAGER import
 * closure (`builtin-shadow-map.ts` pulls it in for a version string), that
 * dead glue is cold-boot payload on every single boot: the 0.0.42 -> 0.0.43
 * bump measured +103 kB on the worker first-load graph. Naming the members
 * we actually use lets tree-shaking drop the initializer we never call.
 * If a future release moves a member we need, add it to `MAGICK` below —
 * do NOT go back to a namespace import.
 */

import {
  AlphaAction,
  ColorSpace,
  Drawables,
  Gravity,
  ImageMagick,
  initializeImageMagick,
  Magick,
  MagickColor,
  MagickFormat,
  MagickGeometry,
  MagickImageCollection,
  Percentage,
} from '@imagemagick/magick-wasm';
import { splitPath } from '../../fs/path-utils.js';
import { compileWasmModule } from '../../kernel/realm/wasm-compiler.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { GLOBAL_IPK_ADD, isNodeRuntime } from './shared.js';

export interface ImageMagickModule {
  initializeImageMagick: (wasmLocation: URL | Uint8Array | WebAssembly.Module) => Promise<void>;
  ImageMagick: {
    read: (data: Uint8Array, callback: (image: IMagickImage) => Promise<void>) => Promise<void>;
  };
  MagickImageCollection: {
    create: () => IMagickImageCollection;
  };
  Drawables: new () => IDrawables;
  MagickColor: new (color: string) => IMagickColor;
  Magick: {
    addFont(name: string, data: Uint8Array): void;
  };
  AlphaAction: Record<string, number>;
  ColorSpace: Record<string, number>;
  Gravity: Record<string, number>;
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
  alpha(value: number): void;
  autoGamma(): void;
  autoLevel(): void;
  autoOrient(): void;
  backgroundColor: IMagickColor;
  blur(radius: number, sigma: number): void;
  colorSpace: number;
  resize(width: number, height: number): void;
  resize(geometry: IMagickGeometry): void;
  rotate(degrees: number): void;
  crop(geometry: IMagickGeometry): void;
  crop(geometry: IMagickGeometry, gravity: number): void;
  crop(width: number, height: number): void;
  extent(geometry: IMagickGeometry): void;
  extent(geometry: IMagickGeometry, gravity: number): void;
  extent(geometry: IMagickGeometry, backgroundColor: IMagickColor): void;
  extent(geometry: IMagickGeometry, gravity: number, backgroundColor: IMagickColor): void;
  flip(): void;
  flop(): void;
  negate(): void;
  normalize(): void;
  quality: number;
  sharpen(radius: number, sigma: number): void;
  strip(): void;
  thumbnail(geometry: IMagickGeometry): void;
  transparent(color: IMagickColor): void;
  trim(): void;
  width: number;
  height: number;
  write(format: string, callback: (data: Uint8Array) => void): void;
  write(callback: (data: Uint8Array) => void): void;
}

export interface IMagickColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface IDrawables {
  fillColor(color: IMagickColor): IDrawables;
  textUnderColor(color: IMagickColor): IDrawables;
  font(name: string): IDrawables;
  fontPointSize(pointSize: number): IDrawables;
  gravity(gravity: number): IDrawables;
  text(x: number, y: number, value: string): IDrawables;
  draw(image: IMagickImage): IDrawables;
}

export interface IMagickImageCollection extends Array<IMagickImage> {
  appendHorizontally(callback: (image: IMagickImage) => Promise<void>): Promise<void>;
  appendVertically(callback: (image: IMagickImage) => Promise<void>): Promise<void>;
  dispose(): void;
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
 * bundled into this build (the named glue imports above resolve
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

const MAGICK_NOT_INSTALLED = `@imagemagick/magick-wasm is not installed in node_modules: run \`${GLOBAL_IPK_ADD} @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}\` (no network fallback)`;

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
      `\`${GLOBAL_IPK_ADD} @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}\` to install the matching version.`
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

/**
 * The glue members `ImageMagickModule` promises, gathered from the named
 * imports. This is what `getMagick` hands back — previously the module
 * namespace object itself, which is what forced Rollup to retain every
 * export (see the header). Property access is identical; only the set of
 * reachable exports changes.
 */
const MAGICK = {
  initializeImageMagick,
  ImageMagick,
  MagickImageCollection,
  Drawables,
  MagickColor,
  Magick,
  AlphaAction,
  ColorSpace,
  Gravity,
  MagickFormat,
  MagickGeometry,
  Percentage,
  // `satisfies` is the guard that keeps this list honest: it fails the build
  // if a member of `ImageMagickModule` is missing here or an extra one is
  // added, which the `as unknown as` cast below cannot catch on its own.
  // The cast stays because the package's own types do not structurally match
  // this hand-written interface — only the KEY SET is checkable.
} satisfies Record<keyof ImageMagickModule, unknown> as unknown as ImageMagickModule;

let magickPromise: Promise<ImageMagickModule> | null = null;

/**
 * Public entry point. Idempotent across calls within a session — the
 * loader memoizes the underlying promise and re-throws the same
 * failure if init was rejected (a fresh import would still reject).
 *
 * In Node / vitest, `ipk` is unused (the WASM binary is resolved from
 * the locally-installed npm package via `import.meta.url`). In every
 * browser runtime — standalone CLI, hosted-leader cloud sandbox,
 * kernel worker, AND the thin-bridge extension leader-tab worker
 * (a hosted `sliccy.ai` origin, not a `chrome-extension://` one) —
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
    await withInitTimeout(initializeImageMagick(wasmUrl));
    return MAGICK;
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
  await withInitTimeout(initializeImageMagick(wasmModule));
  return MAGICK;
}

/**
 * Candidate `magick.wasm` locations inside an ipk-installed
 * `@imagemagick/magick-wasm`, newest layout first.
 *
 * 0.0.43 split the binary by memory model: what used to be a single
 * `dist/magick.wasm` is now `dist/x86/magick.wasm` (32-bit) alongside
 * `dist/x64/magick.wasm` (64-bit). Both layouts are supported here because
 * `ipk add @imagemagick/magick-wasm@<version>` can put either one in the
 * VFS depending on the pinned version.
 *
 * `dist/x64/magick.wasm` is deliberately NOT a candidate. It pairs with the
 * package's `initializeImageMagickx64` entry point, which this module does
 * not bundle (see the header — importing it would drag ~130 kB of unused
 * glue into the kernel worker's cold-boot payload). Handing 64-bit bytes to
 * the 32-bit glue is the same ABI mismatch `assertMagickVersionMatch`
 * guards against by version: emscripten never fulfills a run dependency and
 * the bring-up hangs until `withInitTimeout` fires. Falling back to it
 * would trade a clean "not installed" error for a 30-second hang.
 */
const MAGICK_WASM_CANDIDATES = ['dist/x86/magick.wasm', 'dist/magick.wasm'] as const;

/**
 * First existing `magick.wasm` under `pkgDir`, or null when the install has
 * none (a partial/pruned ipk install, or a future layout change — the
 * caller turns that into the canonical guidance error).
 */
async function findMagickWasm(pkgDir: string, reader: ModuleReader): Promise<string | null> {
  for (const candidate of MAGICK_WASM_CANDIDATES) {
    const path = `${pkgDir}/${candidate}`;
    if (await reader.exists(path)) return path;
  }
  return null;
}

/**
 * Try to read `@imagemagick/magick-wasm/dist/magick.wasm` from an
 * ipk-installed package in the VFS. Resolves
 * `@imagemagick/magick-wasm/package.json` through the shared resolver
 * (so the standard `node_modules` walk and resolution rules apply),
 * derives the package directory from the resolved file, reads the
 * package's `version` (for the glue/wasm compatibility guard), and reads
 * the `magick.wasm` bytes (see `MAGICK_WASM_CANDIDATES` for the
 * supported layouts). Returns `null` on any miss — the caller
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
  const wasmPath = await findMagickWasm(pkgDir, ipk.reader);
  if (!wasmPath) return null;
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
