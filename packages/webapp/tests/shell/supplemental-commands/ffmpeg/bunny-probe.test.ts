import { describe, expect, it } from 'vitest';
import {
  formatSeconds,
  frameRateToRational,
  probeViaMediabunny,
} from '../../../../src/shell/supplemental-commands/ffmpeg/bunny-probe.js';
import { makeWav } from './wav-fixture.js';

describe('probeViaMediabunny', () => {
  it('shapes a WAV like the ffprobe banner parser would', async () => {
    const wav = makeWav({ channels: 2, sampleRate: 44100, seconds: 0.5 });
    const info = await probeViaMediabunny(new Blob([wav]), '/tmp/tone.wav');
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.format.filename).toBe('/tmp/tone.wav');
    expect(info.format.format_name).toBe('wav');
    expect(Number(info.format.duration)).toBeCloseTo(0.5, 2);
    expect(info.format.start_time).toBe('0.000000');
    // 16-bit stereo at 44.1 kHz ≈ 1411 kb/s, plus the header.
    expect(Number(info.format.bit_rate)).toBeGreaterThan(1_400_000);
    expect(info.streams).toHaveLength(1);
    expect(info.streams[0]).toMatchObject({
      index: 0,
      codec_type: 'audio',
      codec_name: 'pcm_s16le',
      sample_rate: '44100',
      channels: 2,
      channel_layout: 'stereo',
    });
    expect(Number(info.streams[0].duration)).toBeCloseTo(0.5, 2);
  }, 20_000);

  it('returns null for a container mediabunny does not read', async () => {
    await expect(
      probeViaMediabunny(new Blob([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])]), 'x.bin')
    ).resolves.toBeNull();
  });
});

describe('ffprobe number formatting', () => {
  it('prints six-decimal seconds', () => {
    expect(formatSeconds(1)).toBe('1.000000');
    expect(formatSeconds(0.123456789)).toBe('0.123457');
  });

  it('prints frame rates as the rationals ffprobe uses', () => {
    expect(frameRateToRational(30)).toBe('30/1');
    expect(frameRateToRational(29.97)).toBe('30000/1001');
    expect(frameRateToRational(23.976)).toBe('24000/1001');
    expect(frameRateToRational(59.94)).toBe('60000/1001');
    expect(frameRateToRational(12.5)).toBe('12500/1000');
    expect(frameRateToRational(0)).toBe('0/0');
    expect(frameRateToRational(Number.NaN)).toBe('0/0');
  });
});
