import { describe, expect, it } from 'vitest';
import {
  FFMPEG_CORE_ENV,
  FFMPEG_ENGINE_ENV,
  ffmpegCoreFromEnv,
  ffmpegEngineFromEnv,
} from '../../../../src/shell/supplemental-commands/ffmpeg/engine.js';

describe('ffmpegEngineFromEnv', () => {
  it('defaults to auto', () => {
    expect(ffmpegEngineFromEnv(undefined)).toBe('auto');
    expect(ffmpegEngineFromEnv(new Map())).toBe('auto');
    expect(ffmpegEngineFromEnv(new Map([[FFMPEG_ENGINE_ENV, 'turbo']]))).toBe('auto');
  });

  it('reads wasm / mediabunny case-insensitively', () => {
    expect(ffmpegEngineFromEnv(new Map([[FFMPEG_ENGINE_ENV, 'wasm']]))).toBe('wasm');
    expect(ffmpegEngineFromEnv(new Map([[FFMPEG_ENGINE_ENV, ' MediaBunny ']]))).toBe('mediabunny');
  });
});

describe('ffmpegCoreFromEnv', () => {
  it('defaults to the single-threaded core and only opts into mt explicitly', () => {
    expect(ffmpegCoreFromEnv(undefined)).toBe('st');
    expect(ffmpegCoreFromEnv(new Map())).toBe('st');
    expect(ffmpegCoreFromEnv(new Map([[FFMPEG_CORE_ENV, 'MT ']]))).toBe('mt');
    expect(ffmpegCoreFromEnv(new Map([[FFMPEG_CORE_ENV, 'multi']]))).toBe('st');
  });
});
