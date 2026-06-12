import { describe, expect, it } from 'vitest';
import { toKokoroVoiceInfos } from '../../src/speech/kokoro-engine.js';

describe('toKokoroVoiceInfos', () => {
  it('normalizes kokoro-js voice metadata into picker entries', () => {
    const infos = toKokoroVoiceInfos({
      af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' },
      am_adam: { name: 'Adam', language: 'en-us', gender: 'Male' },
      bm_george: { name: 'George', language: 'en-gb', gender: 'Male' },
    });
    expect(infos).toEqual([
      { id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'Female' },
      { id: 'am_adam', name: 'Adam', lang: 'en-US', gender: 'Male' },
      { id: 'bm_george', name: 'George', lang: 'en-GB', gender: 'Male' },
    ]);
  });

  it('falls back to the id and the id-prefix language when metadata is sparse', () => {
    expect(toKokoroVoiceInfos({ bf_alice: {} })).toEqual([
      { id: 'bf_alice', name: 'bf_alice', lang: 'en-GB' },
    ]);
  });
});
