/**
 * Which engine `ffmpeg` / `ffprobe` run on.
 *
 * - `auto` (default): mediabunny for argv it can express exactly, the
 *   `@ffmpeg/core` wasm for everything else.
 * - `wasm`: always the wasm core — the escape hatch when byte-identical
 *   ffmpeg output matters (an A/B, a golden file).
 * - `mediabunny`: mediabunny or fail — surfaces *why* the fast path
 *   declined instead of silently falling back.
 *
 * Read from the shell environment (`FFMPEG_ENGINE=wasm ffmpeg …`) so an
 * agent can flip it per command without any UI.
 */

export type FfmpegEngine = 'auto' | 'wasm' | 'mediabunny';

export const FFMPEG_ENGINE_ENV = 'FFMPEG_ENGINE';

export function ffmpegEngineFromEnv(env: Map<string, string> | undefined): FfmpegEngine {
  const raw = env?.get(FFMPEG_ENGINE_ENV)?.trim().toLowerCase();
  if (raw === 'wasm' || raw === 'mediabunny') return raw;
  return 'auto';
}

/**
 * Which wasm core the `ffmpeg` / `ffprobe` fallback boots.
 *
 * - `st` (default): `@ffmpeg/core`, single-threaded, works everywhere.
 * - `mt`: `@ffmpeg/core-mt` (pthreads over SharedArrayBuffer). Faster for
 *   single-input encodes on a cross-origin-isolated leader, but it
 *   DEADLOCKS on any job with more than one input — ffmpeg spawns a demux
 *   thread per input and emscripten proxies `pthread_create` from those
 *   threads to a main thread that is blocked inside `exec` (verified live
 *   on the standalone harness, 2026-09-03). Opt-in until that is fixed.
 */
export type FfmpegCorePreference = 'st' | 'mt';

export const FFMPEG_CORE_ENV = 'FFMPEG_CORE';

export function ffmpegCoreFromEnv(env: Map<string, string> | undefined): FfmpegCorePreference {
  return env?.get(FFMPEG_CORE_ENV)?.trim().toLowerCase() === 'mt' ? 'mt' : 'st';
}
