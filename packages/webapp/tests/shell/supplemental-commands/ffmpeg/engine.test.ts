import { describe, expect, it } from 'vitest';
import {
  FFMPEG_ENGINE_ENV,
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
