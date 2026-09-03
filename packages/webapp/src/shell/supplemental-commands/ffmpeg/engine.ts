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
