/**
 * Shared ffmpeg-wasm loader. Bundled as the small `@ffmpeg/ffmpeg`
 * JS wrapper; the large `@ffmpeg/core` artifacts (`ffmpeg-core.js`
 * + `ffmpeg-core.wasm`, ~31 MB combined) are intentionally NOT
 * bundled and are fetched on demand the first time `ffmpeg` runs
 * in a session.
 *
 * Caching: downloaded bytes are stored via the Cache Storage API
 * under a versioned name so subsequent loads (same session OR
 * across reloads) skip the network. The HTTP cache alone is too
 * volatile for a 31 MB asset — it gets evicted aggressively, and
 * the user-facing latency on every cold start is painful.
 *
 * Extension mode: cross-origin `importScripts` is blocked under the
 * extension origin's CSP, so we fetch the core JS + wasm + the
 * library's inner-worker JS as bytes and hand the loader same-
 * origin `blob:` URLs. The worker can then `importScripts(blobUrl)`
 * without tripping CSP.
 *
 * Standalone CLI: `unpkg.com` ships CORS-enabled responses, so the
 * loader feeds it the bare CDN URLs. The proxied-fetch path on the
 * page side handles the bytes-into-cache hop transparently.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { isExtensionRuntime } from './shared.js';

// Versions are pinned in `packages/webapp/package.json`. The CDN
// path for the core artifacts is decoupled from the wrapper version
// because @ffmpeg/ffmpeg and @ffmpeg/core release on independent
// cadences.
const FFMPEG_CORE_VERSION = '0.12.10';
const FFMPEG_PKG_VERSION = '0.12.15';

// @ffmpeg/ffmpeg always spawns its inner worker as `type: "module"`,
// so `importScripts(coreURL)` synchronously fails (module workers
// have no `importScripts`). The loader then falls back to a dynamic
// `import(coreURL)` and reads `.default` off the namespace. Only the
// ESM build of `@ffmpeg/core` provides that default export; the UMD
// build is a side-effecting IIFE with no exports and therefore
// surfaces as `ERROR_IMPORT_FAILURE` ("failed to import
// ffmpeg-core.js"). Always point at /esm/.
export const FFMPEG_CORE_CDN_BASE = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm/`;
export const FFMPEG_WORKER_CDN_BASE = `https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_PKG_VERSION}/dist/esm/`;

const CACHE_NAME = `slicc-ffmpeg-${FFMPEG_CORE_VERSION}-${FFMPEG_PKG_VERSION}`;

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
 */
export async function getFfmpeg(
  options: { onProgress?: (msg: string) => void } = {}
): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = loadFfmpeg(options.onProgress).catch((err) => {
      // Reset on failure so the next call retries from scratch.
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

async function loadFfmpeg(onProgress?: (msg: string) => void): Promise<FFmpeg> {
  const log = onProgress ?? (() => {});
  const ffmpeg = new FFmpeg();
  const assets = await resolveAssetUrls(log);
  log('initializing ffmpeg-core...');
  await ffmpeg.load({
    coreURL: assets.coreURL,
    wasmURL: assets.wasmURL,
    ...(assets.classWorkerURL ? { classWorkerURL: assets.classWorkerURL } : {}),
  });
  log('ffmpeg ready');
  return ffmpeg;
}

async function resolveAssetUrls(log: (msg: string) => void): Promise<FfmpegAssetUrls> {
  const coreUrl = `${FFMPEG_CORE_CDN_BASE}ffmpeg-core.js`;
  const wasmUrl = `${FFMPEG_CORE_CDN_BASE}ffmpeg-core.wasm`;
  const workerUrl = `${FFMPEG_WORKER_CDN_BASE}worker.js`;

  if (!isExtensionRuntime()) {
    // Pre-warm the Cache Storage so the worker's importScripts call
    // hits hot bytes on subsequent reloads. Only the core JS + wasm
    // are pre-fetched here; the inner worker JS comes from the npm
    // bundle (same-origin) in standalone mode.
    await Promise.all([preloadIntoCache(coreUrl, log), preloadIntoCache(wasmUrl, log)]);
    return { coreURL: coreUrl, wasmURL: wasmUrl };
  }

  // Extension origin: stage all three assets through blob URLs so
  // the loader's `importScripts(coreURL)` and the implicit
  // worker spawn both stay same-origin under the extension CSP.
  log('downloading ffmpeg-core (cached after first run)...');
  const [coreBytes, wasmBytes, workerBytes] = await Promise.all([
    fetchWithCache(coreUrl, 'application/javascript', log),
    fetchWithCache(wasmUrl, 'application/wasm', log),
    fetchWithCache(workerUrl, 'application/javascript', log),
  ]);
  return {
    coreURL: bytesToBlobUrl(coreBytes, 'application/javascript'),
    wasmURL: bytesToBlobUrl(wasmBytes, 'application/wasm'),
    classWorkerURL: bytesToBlobUrl(workerBytes, 'application/javascript'),
  };
}

async function preloadIntoCache(url: string, log: (msg: string) => void): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return;
    log(`fetching ${shortUrl(url)}...`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`ffmpeg-core fetch ${url} failed: HTTP ${res.status}`);
    }
    await cache.put(url, res.clone());
  } catch (err) {
    // Cache failures shouldn't block a working network — the
    // loader will fall back to live HTTP next time.
    log(`cache preload failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function fetchWithCache(
  url: string,
  contentType: string,
  log: (msg: string) => void
): Promise<Uint8Array> {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        return new Uint8Array(await hit.arrayBuffer());
      }
    } catch {
      /* fall through to network */
    }
  }
  log(`fetching ${shortUrl(url)}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ffmpeg asset fetch ${url} failed: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME);
      const stored = new Response(bytes, { headers: { 'content-type': contentType } });
      await cache.put(url, stored);
    } catch {
      /* best-effort */
    }
  }
  return bytes;
}

function bytesToBlobUrl(bytes: Uint8Array, contentType: string): string {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return URL.createObjectURL(new Blob([buffer], { type: contentType }));
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').slice(0, 64);
}

/**
 * Drop the cached `FFmpeg` instance. Test-only — production
 * callers share the single loaded instance for the lifetime of the
 * realm. Returns the now-discarded instance so tests can assert on
 * cleanup.
 */
export function resetFfmpegForTests(): void {
  ffmpegPromise = null;
}
