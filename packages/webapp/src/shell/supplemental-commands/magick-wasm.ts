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

export const MIME_TO_MAGICK_FORMAT: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
  'image/avif': 'AVIF',
};

export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

export const BUNDLED_MAGICK_VERSION = __MAGICK_WASM_VERSION__;

const MAGICK_NOT_INSTALLED = `@imagemagick/magick-wasm is not installed in node_modules: run \`${GLOBAL_IPK_ADD} @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}\` (no network fallback)`;

function magickVersionMismatchError(installed: string): Error {
  return new Error(
    `@imagemagick/magick-wasm version mismatch: the bundled JS glue is ` +
      `${BUNDLED_MAGICK_VERSION} but ${installed} is installed in node_modules. ` +
      `The Emscripten glue and magick.wasm must be the same version or ` +
      `initializeImageMagick hangs in the kernel worker. Run ` +
      `\`${GLOBAL_IPK_ADD} @imagemagick/magick-wasm@${BUNDLED_MAGICK_VERSION}\` to install the matching version.`
  );
}

export function assertMagickVersionMatch(installedVersion: string): void {
  if (installedVersion !== BUNDLED_MAGICK_VERSION) {
    throw magickVersionMismatchError(installedVersion);
  }
}

export const MAGICK_INIT_TIMEOUT_MS = 30_000;

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
} satisfies Record<keyof ImageMagickModule, unknown> as unknown as ImageMagickModule;

let magickPromise: Promise<ImageMagickModule> | null = null;

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
    const wasmBase = new URL(
      '../../../../../node_modules/@imagemagick/magick-wasm/dist/',
      import.meta.url
    ).toString();
    const wasmUrl = new URL('magick.wasm', wasmBase);
    await withInitTimeout(initializeImageMagick(wasmUrl));
    return MAGICK;
  }

  if (!ipk) throw new Error(MAGICK_NOT_INSTALLED);
  const installed = await tryLoadMagickWasmFromNodeModules(ipk);
  if (!installed) throw new Error(MAGICK_NOT_INSTALLED);

  assertMagickVersionMatch(installed.version);
  const bytes = installed.bytes;

  const wasmModule = await compileWasmModule(bytes);
  await withInitTimeout(initializeImageMagick(wasmModule));
  return MAGICK;
}

const MAGICK_WASM_CANDIDATES = ['dist/x86/magick.wasm', 'dist/magick.wasm'] as const;

async function findMagickWasm(pkgDir: string, reader: ModuleReader): Promise<string | null> {
  for (const candidate of MAGICK_WASM_CANDIDATES) {
    const path = `${pkgDir}/${candidate}`;
    if (await reader.exists(path)) return path;
  }
  return null;
}

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
  } catch {}
  try {
    return { bytes: await ipk.readBytes(wasmPath), version };
  } catch {
    return null;
  }
}

export function resetMagickForTests(): void {
  magickPromise = null;
}
