import { FFmpeg } from '@ffmpeg/ffmpeg';
import { splitPath } from '../../fs/path-utils.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { GLOBAL_IPK_ADD, isNodeRuntime } from './shared.js';

export const BUNDLED_FFMPEG_CORE_VERSION = __FFMPEG_CORE_VERSION__;

export const FFMPEG_CORE_NOT_INSTALLED = `@ffmpeg/core is not installed in node_modules: run \`${GLOBAL_IPK_ADD} @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}\` (no network fallback)`;

export const FFMPEG_CORE_MT_PACKAGE = '@ffmpeg/core-mt';

export const FFMPEG_CORE_MT_NOT_INSTALLED = `@ffmpeg/core-mt is not installed in node_modules (FFMPEG_CORE=mt asked for the multi-threaded core): run \`${GLOBAL_IPK_ADD} ${FFMPEG_CORE_MT_PACKAGE}@${BUNDLED_FFMPEG_CORE_VERSION}\`, or unset FFMPEG_CORE and run \`${GLOBAL_IPK_ADD} @ffmpeg/core@${BUNDLED_FFMPEG_CORE_VERSION}\` (no network fallback)`;

export function isCrossOriginIsolated(): boolean {
  return globalThis.crossOriginIsolated === true;
}

export function ffmpegCoreNotInstalledMessage(preferMt = false): string {
  return preferMt && isCrossOriginIsolated()
    ? FFMPEG_CORE_MT_NOT_INSTALLED
    : FFMPEG_CORE_NOT_INSTALLED;
}

export function describeFfmpegCore(
  loaded: Pick<LoadedFfmpegCore, 'pkg'>,
  isolated = isCrossOriginIsolated(),
  cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined
): string {
  const version = `${loaded.pkg} ${BUNDLED_FFMPEG_CORE_VERSION}`;
  if (loaded.pkg === FFMPEG_CORE_MT_PACKAGE) {
    const threads = typeof cores === 'number' && cores > 0 ? `, ${cores} threads` : '';
    return `${version} (multi-threaded${threads}; single-input jobs only)`;
  }
  if (isolated) {
    return `${version} (single-threaded; the multi-threaded core is opt-in on this isolated runtime: \`${GLOBAL_IPK_ADD} ${FFMPEG_CORE_MT_PACKAGE}@${BUNDLED_FFMPEG_CORE_VERSION}\` then FFMPEG_CORE=mt, single-input jobs only)`;
  }
  return `${version} (single-threaded; runtime is not cross-origin isolated)`;
}

export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

interface FfmpegAssetUrls {
  pkg: LoadedFfmpegCore['pkg'];
  coreURL: string;
  wasmURL: string;
  classWorkerURL?: string;

  workerURL?: string;
}

export interface LoadedFfmpegCore {
  pkg: typeof FFMPEG_CORE_PACKAGE | typeof FFMPEG_CORE_MT_PACKAGE;
  coreSource: string;
  wasmBytes: Uint8Array;

  workerSource?: string;
}

const FFMPEG_CORE_PACKAGE = '@ffmpeg/core';

const FFMPEG_CORE_LAYOUTS = ['dist/esm'] as const;

interface FfmpegCoreFiles {
  core: string;
  wasm: string;

  worker: string | null;
}

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

let currentFfmpeg: FFmpeg | null = null;

let currentAssetUrls: string[] = [];

let currentCorePkg: LoadedFfmpegCore['pkg'] | null = null;

export function loadedFfmpegCorePackage(): LoadedFfmpegCore['pkg'] | null {
  return currentCorePkg;
}

function revokeAssetUrls(urls: string[]): void {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
}

export async function getFfmpeg(
  options: {
    onProgress?: (msg: string) => void;
    ipk?: IpkResolutionContext;

    preferMt?: boolean;
  } = {}
): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = loadFfmpeg(options.onProgress, options.ipk, options.preferMt === true).catch(
      (err) => {
        ffmpegPromise = null;
        throw err;
      }
    );
  }
  return ffmpegPromise;
}

async function loadFfmpeg(
  onProgress: ((msg: string) => void) | undefined,
  ipk: IpkResolutionContext | undefined,
  preferMt: boolean
): Promise<FFmpeg> {
  const log = onProgress ?? (() => {});
  const ffmpeg = new FFmpeg();
  const assets = await resolveAssetUrls(ipk, log, preferMt);
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
    revokeAssetUrls(urls);
    throw err;
  }
  log('ffmpeg ready');
  currentFfmpeg = ffmpeg;
  currentAssetUrls = urls;
  currentCorePkg = assets.pkg;
  return ffmpeg;
}

export async function tryLoadFfmpegCoreFromNodeModules(
  ipk: IpkResolutionContext,
  pkg?: LoadedFfmpegCore['pkg'],
  preferMt = false
): Promise<LoadedFfmpegCore | null> {
  if (pkg === undefined) {
    return selectFfmpegCore(ipk, preferMt && isCrossOriginIsolated());
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

export async function selectFfmpegCore(
  ipk: IpkResolutionContext,
  preferMt: boolean
): Promise<LoadedFfmpegCore | null> {
  if (preferMt) {
    const mt = await tryLoadFfmpegCoreFromNodeModules(ipk, FFMPEG_CORE_MT_PACKAGE);
    if (mt) return mt;
  }

  return tryLoadFfmpegCoreFromNodeModules(ipk, FFMPEG_CORE_PACKAGE);
}

async function resolveAssetUrls(
  ipk: IpkResolutionContext | undefined,
  log: (msg: string) => void,
  preferMt: boolean
): Promise<FfmpegAssetUrls> {
  if (isNodeRuntime()) {
    throw new Error('ffmpeg-wasm is not available in Node runtime');
  }
  const wantMt = preferMt && isCrossOriginIsolated();
  if (!ipk) throw new Error(ffmpegCoreNotInstalledMessage(wantMt));
  const loaded = await selectFfmpegCore(ipk, wantMt);
  if (!loaded) throw new Error(ffmpegCoreNotInstalledMessage(wantMt));

  log(
    `${loaded.pkg} loaded from ipk node_modules (js: ${loaded.coreSource.length} chars, wasm: ${loaded.wasmBytes.byteLength} bytes${loaded.workerSource ? ', multi-threaded' : ''})`
  );
  const wasmURL = bytesToBlobUrl(loaded.wasmBytes, 'application/wasm');

  return {
    pkg: loaded.pkg,
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

export function isCoreFault(err: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) return true;
  if (err instanceof RangeError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /RuntimeError|memory access out of bounds|unreachable|Aborted|out of memory|allocation failed|table index is out of bounds|function signature mismatch/i.test(
    message
  );
}

export function recycleFfmpeg(faulted?: FFmpeg): void {
  if (faulted !== undefined && currentFfmpeg !== faulted) return;

  const stale = currentFfmpeg;
  const staleUrls = currentAssetUrls;
  ffmpegPromise = null;
  currentFfmpeg = null;
  currentAssetUrls = [];
  currentCorePkg = null;

  if (stale) {
    try {
      stale.terminate();
    } catch {}
  }
  revokeAssetUrls(staleUrls);
}

export function resetFfmpegForTests(): void {
  ffmpegPromise = null;
  currentFfmpeg = null;
  currentAssetUrls = [];
  currentCorePkg = null;
}
