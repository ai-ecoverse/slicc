export type FfmpegEngine = 'auto' | 'wasm' | 'mediabunny';

export const FFMPEG_ENGINE_ENV = 'FFMPEG_ENGINE';

export function ffmpegEngineFromEnv(env: Map<string, string> | undefined): FfmpegEngine {
  const raw = env?.get(FFMPEG_ENGINE_ENV)?.trim().toLowerCase();
  if (raw === 'wasm' || raw === 'mediabunny') return raw;
  return 'auto';
}

export type FfmpegCorePreference = 'st' | 'mt';

export const FFMPEG_CORE_ENV = 'FFMPEG_CORE';

export function ffmpegCoreFromEnv(env: Map<string, string> | undefined): FfmpegCorePreference {
  return env?.get(FFMPEG_CORE_ENV)?.trim().toLowerCase() === 'mt' ? 'mt' : 'st';
}
