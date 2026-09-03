/**
 * Real mediabunny under Node. PCM WAV needs no WebCodecs, so a WAV →
 * WAV downmix/resample runs the genuine read → convert → write pipeline;
 * garbage input exercises the `declined` contract the wasm fallback
 * depends on.
 */
import { describe, expect, it } from 'vitest';
import {
  audioOptionsFor,
  loadMediabunny,
  runViaMediabunny,
  videoOptionsFor,
} from '../../../../src/shell/supplemental-commands/ffmpeg/bunny-run.js';
import type { BunnyPlan } from '../../../../src/shell/supplemental-commands/ffmpeg/bunny-translate.js';
import { makeWav, readWavHeader } from './wav-fixture.js';

const wavPlan = (audio: BunnyPlan['audio']): BunnyPlan => ({
  container: 'wav',
  video: {},
  audio,
  fastStart: false,
});

describe('runViaMediabunny', () => {
  it('downmixes and resamples a WAV without any wasm', async () => {
    const input = new Blob([makeWav({ channels: 2, sampleRate: 44100, seconds: 0.2 })]);
    const log: string[] = [];
    const res = await runViaMediabunny({
      plan: wavPlan({ numberOfChannels: 1, sampleRate: 8000 }),
      input,
      onLog: (l) => log.push(l),
    });
    expect(res.kind).toBe('done');
    if (res.kind !== 'done') return;
    const header = readWavHeader(res.bytes);
    expect(header.channels).toBe(1);
    expect(header.sampleRate).toBe(8000);
    expect(header.bitsPerSample).toBe(16);
    // 0.2 s × 8000 Hz × 1 ch × 2 bytes, within a frame or two of resampling slack.
    expect(Math.abs(header.dataBytes - 3200)).toBeLessThan(200);
    expect(res.summary).toBe('audio → wav');
    expect(log.some((l) => l.startsWith('mediabunny: '))).toBe(true);
    expect(log.some((l) => /^progress: \d+%$/.test(l))).toBe(true);
  }, 20_000);

  it('honours a trim window', async () => {
    const input = new Blob([makeWav({ channels: 1, sampleRate: 8000, seconds: 1 })]);
    const res = await runViaMediabunny({
      plan: { ...wavPlan({}), trim: { start: 0.25, end: 0.5 } },
      input,
      onLog: () => {},
    });
    expect(res.kind).toBe('done');
    if (res.kind !== 'done') return;
    expect(Math.abs(readWavHeader(res.bytes).dataBytes - 0.25 * 8000 * 2)).toBeLessThan(400);
  }, 20_000);

  it('declines an input mediabunny cannot read so the wasm core takes it', async () => {
    const res = await runViaMediabunny({
      plan: wavPlan({}),
      input: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]),
      onLog: () => {},
    });
    expect(res.kind).toBe('declined');
    if (res.kind === 'declined') expect(res.reason).toMatch(/not a container mediabunny reads/);
  });

  it('declines when a track it did not ask to drop cannot be written', async () => {
    // mp3 output from a WAV needs an MP3 encoder — Node has no WebCodecs
    // and the extension package is not installed, so mediabunny would
    // drop the only track. That must be a decline, never a silent
    // audio-less file.
    const res = await runViaMediabunny({
      plan: { container: 'mp3', video: {}, audio: { codec: 'mp3' }, fastStart: false },
      input: new Blob([makeWav({ seconds: 0.1 })]),
      onLog: () => {},
    });
    expect(res.kind).toBe('declined');
    if (res.kind === 'declined')
      expect(res.reason).toMatch(/audio track .*no encodable target codec/);
  }, 20_000);
});

describe('option mapping', () => {
  it('maps a video plan onto ConversionVideoOptions field by field', async () => {
    const mb = await loadMediabunny();
    expect(videoOptionsFor(mb, { discard: true })).toEqual({ discard: true });
    const opts = videoOptionsFor(mb, {
      codec: 'avc',
      quality: 'high',
      width: 640,
      height: 360,
      fit: 'fill',
      rotate: 90,
      crop: { left: 1, top: 2, width: 3, height: 4 },
      frameRate: 24,
      keyFrameInterval: 2,
      forceTranscode: true,
    });
    expect(opts).toMatchObject({
      codec: 'avc',
      width: 640,
      height: 360,
      fit: 'fill',
      rotate: 90,
      crop: { left: 1, top: 2, width: 3, height: 4 },
      frameRate: 24,
      keyFrameInterval: 2,
      forceTranscode: true,
    });
    expect(opts.bitrate).toBe(mb.QUALITY_HIGH);
    // An explicit bitrate wins over a quality preset.
    expect(videoOptionsFor(mb, { bitrate: 500_000, quality: 'low' }).bitrate).toBe(500_000);
  });

  it('maps an audio plan onto ConversionAudioOptions', async () => {
    const mb = await loadMediabunny();
    expect(audioOptionsFor(mb, { discard: true })).toEqual({ discard: true });
    expect(
      audioOptionsFor(mb, {
        codec: 'opus',
        quality: 'very_low',
        numberOfChannels: 2,
        sampleRate: 48000,
      })
    ).toEqual({
      codec: 'opus',
      bitrate: mb.QUALITY_VERY_LOW,
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    expect(audioOptionsFor(mb, {})).toEqual({});
  });
});
