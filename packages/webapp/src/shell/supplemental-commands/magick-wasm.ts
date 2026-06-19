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
 */

import { splitPath } from '../../fs/path-utils.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { isNodeRuntime } from './shared.js';

export interface ImageMagickModule {
  initializeImageMagick: (wasmLocation: URL | Uint8Array) => Promise<void>;
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

const MAGICK_NOT_INSTALLED =
  '@imagemagick/magick-wasm is not installed in node_modules: run `ipk add @imagemagick/magick-wasm` (no network fallback)';

let magickPromise: Promise<ImageMagickModule> | null = null;
export const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

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
  const magickModule = await import('@imagemagick/magick-wasm');
  if (isExtension) {
    // Chrome extension — fetch bundled WASM as bytes.
    // initializeImageMagick rejects chrome-extension:// URLs, so pass Uint8Array.
    const wasmUrl = chrome.runtime.getURL('magick.wasm');
    const resp = await fetch(wasmUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch magick.wasm: ${resp.status} ${resp.statusText}`);
    }
    const wasmBytes = new Uint8Array(await resp.arrayBuffer());
    await magickModule.initializeImageMagick(wasmBytes);
    return magickModule as unknown as ImageMagickModule;
  }
  if (isNodeRuntime()) {
    // Node / vitest — resolve the locally-installed npm package's
    // `magick.wasm` via `import.meta.url`. No network, no ipk required.
    const wasmBase = new URL(
      '../../../../../node_modules/@imagemagick/magick-wasm/dist/',
      import.meta.url
    ).toString();
    const wasmUrl = new URL('magick.wasm', wasmBase);
    await magickModule.initializeImageMagick(wasmUrl);
    return magickModule as unknown as ImageMagickModule;
  }
  // Browser (standalone OR any non-extension browser realm): an
  // ipk-installed copy of `@imagemagick/magick-wasm/dist/magick.wasm`
  // in the VFS `node_modules` is the only supported source. Without
  // it, surface a clean error rather than reaching out to the network.
  if (!ipk) throw new Error(MAGICK_NOT_INSTALLED);
  const bytes = await tryLoadMagickWasmFromNodeModules(ipk);
  if (!bytes) throw new Error(MAGICK_NOT_INSTALLED);
  // Materialize the underlying ArrayBuffer explicitly so the
  // `initializeImageMagick(Uint8Array)` typings don't trip on the
  // `SharedArrayBuffer | ArrayBuffer` union that Uint8Array<...>
  // carries under newer lib.dom.d.ts.
  const wasmBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(wasmBuffer).set(bytes);
  await magickModule.initializeImageMagick(new Uint8Array(wasmBuffer));
  return magickModule as unknown as ImageMagickModule;
}

/**
 * Try to read `@imagemagick/magick-wasm/dist/magick.wasm` from an
 * ipk-installed package in the VFS. Resolves
 * `@imagemagick/magick-wasm/package.json` through the shared resolver
 * (so the standard `node_modules` walk and resolution rules apply),
 * derives the package directory from the resolved file, and reads
 * `dist/magick.wasm` bytes. Returns `null` on any miss — the caller
 * surfaces the canonical guidance error.
 *
 * Exported so the loader's resolution behavior is unit-testable
 * without booting the heavy WASM service.
 */
export async function tryLoadMagickWasmFromNodeModules(
  ipk: IpkResolutionContext
): Promise<Uint8Array | null> {
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
  try {
    return await ipk.readBytes(wasmPath);
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
