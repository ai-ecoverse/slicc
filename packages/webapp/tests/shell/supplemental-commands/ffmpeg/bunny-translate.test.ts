import { describe, expect, it } from 'vitest';
import {
  audioQscaleToQuality,
  type BunnyPlan,
  crfToQuality,
  parseBitrate,
  parseTime,
  translateToMediabunny,
} from '../../../../src/shell/supplemental-commands/ffmpeg/bunny-translate.js';
import { parseFfmpegArgs } from '../../../../src/shell/supplemental-commands/ffmpeg/run.js';

function plan(argv: string[]): BunnyPlan {
  const t = translateToMediabunny(parseFfmpegArgs(argv));
  if (!t.ok) throw new Error(`expected a plan, got rejection: ${t.reason}`);
  return t.plan;
}

function rejection(argv: string[]): string {
  const t = translateToMediabunny(parseFfmpegArgs(argv));
  if (t.ok) throw new Error(`expected a rejection, got plan ${JSON.stringify(t.plan)}`);
  return t.reason;
}

describe('translateToMediabunny — accepted shapes', () => {
  it('maps a plain remux by extension, copying both streams', () => {
    const p = plan(['-i', 'in.mkv', 'out.mp4']);
    expect(p.container).toBe('mp4');
    expect(p.video).toEqual({});
    expect(p.audio).toEqual({});
    expect(p.fastStart).toBe(false);
    expect(p.trim).toBeUndefined();
  });

  it('maps codecs, bitrates, crf and faststart onto a transcode', () => {
    const p = plan([
      '-i',
      'in.mov',
      '-c:v',
      'libx264',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      'out.mp4',
    ]);
    expect(p.video).toEqual({ codec: 'avc', quality: 'high', forceTranscode: true });
    expect(p.audio).toEqual({ codec: 'aac', bitrate: 128_000, forceTranscode: true });
    expect(p.fastStart).toBe('in-memory');
  });

  it('honours -c copy explicitly (no codec, no forced transcode)', () => {
    const p = plan([
      '-i',
      'in.mp4',
      '-c',
      'copy',
      '-bsf:v',
      'h264_mp4toannexb',
      '-f',
      'mpegts',
      'out.ts',
    ]);
    expect(p.container).toBe('mpegts');
    expect(p.video.codec).toBeUndefined();
    expect(p.video.forceTranscode).toBeUndefined();
  });

  it('maps -an / -vn to discards and -ac / -ar to audio transforms', () => {
    const p = plan(['-i', 'in.mp4', '-vn', '-ac', '1', '-ar', '16000', 'out.wav']);
    expect(p.video).toEqual({ discard: true });
    expect(p.audio).toEqual({ numberOfChannels: 1, sampleRate: 16000 });
    expect(p.container).toBe('wav');
  });

  it('maps scale / crop / transpose / fps video filters', () => {
    const p = plan([
      '-i',
      'in.mp4',
      '-vf',
      'scale=1280:720,crop=640:360:10:20,transpose=1,fps=24,format=yuv420p',
      'out.mp4',
    ]);
    expect(p.video).toMatchObject({
      width: 1280,
      height: 720,
      fit: 'fill',
      crop: { width: 640, height: 360, left: 10, top: 20 },
      rotate: 90,
      frameRate: 24,
    });
  });

  it('keeps the aspect ratio for scale=W:-1 and scale=-2:H', () => {
    expect(plan(['-i', 'in.mp4', '-vf', 'scale=640:-1', 'o.mp4']).video).toEqual({ width: 640 });
    expect(plan(['-i', 'in.mp4', '-vf', 'scale=-2:480', 'o.mp4']).video).toEqual({ height: 480 });
    expect(plan(['-i', 'in.mp4', '-vf', 'scale=w=320:h=240', 'o.mp4']).video).toEqual({
      width: 320,
      height: 240,
      fit: 'fill',
    });
  });

  it('turns -ss / -t / -to on either side of -i into a trim', () => {
    expect(plan(['-ss', '00:00:10', '-i', 'in.mp4', '-t', '5', 'out.mp4']).trim).toEqual({
      start: 10,
      end: 15,
    });
    expect(plan(['-i', 'in.mp4', '-ss', '2.5', '-to', '7', 'out.mp4']).trim).toEqual({
      start: 2.5,
      end: 7,
    });
  });

  it('turns -g into a key-frame interval when -r is known', () => {
    expect(plan(['-i', 'in.mp4', '-r', '30', '-g', '60', 'out.mp4']).video.keyFrameInterval).toBe(
      2
    );
  });

  it('collects -metadata into tags and ignores effort-only flags', () => {
    const p = plan([
      '-y',
      '-hide_banner',
      '-i',
      'in.mp3',
      '-threads',
      '4',
      '-preset',
      'slow',
      '-metadata',
      'title=Hello',
      '-metadata',
      'album_artist=Band',
      '-map',
      '0',
      'out.m4a',
    ]);
    expect(p.tags).toEqual({ title: 'Hello', albumArtist: 'Band' });
    expect(p.container).toBe('mp4');
  });

  it('accepts -f on the output over the extension, and -s WxH', () => {
    const p = plan(['-i', 'in.mp4', '-s', '640x480', '-f', 'matroska', 'weird.bin']);
    expect(p.container).toBe('mkv');
    expect(p.video).toEqual({ width: 640, height: 480, fit: 'fill' });
  });

  it('accepts a readable input -f and rejects a synthesized one', () => {
    expect(plan(['-f', 'mp4', '-i', 'in.bin', 'out.mp4']).container).toBe('mp4');
    expect(rejection(['-f', 'lavfi', '-i', 'testsrc', 'out.mp4'])).toMatch(/lavfi/);
    expect(rejection(['-f', 'concat', '-i', 'list.txt', 'out.mp4'])).toMatch(/concat/);
    expect(rejection(['-f', 'rawvideo', '-i', 'in.yuv', 'out.mp4'])).toMatch(/rawvideo/);
  });
});

describe('translateToMediabunny — rejections name the option', () => {
  it.each([
    [['-i', 'a.mp4', '-i', 'b.mp4', 'o.mp4'], /more than one input/],
    [['-i', 'a.mp4', '-vf', 'drawtext=text=hi', 'o.mp4'], /drawtext/],
    [['-i', 'a.mp4', '-af', 'loudnorm', 'o.mp4'], /loudnorm/],
    [['-i', 'a.mp4', '-c:v', 'mpeg4', 'o.mp4'], /mpeg4/],
    [['-i', 'a.mp4', '-c:a', 'ac3', 'o.mp4'], /ac3/],
    [['-i', 'a.mp4', 'o.gif'], /o\.gif/],
    [['-i', 'a.mp4', '-frames:v', '1', 'o.png'], /frames:v|o\.png/],
    [['-i', 'a.mp4', '-map', '0:a:1', 'o.mp4'], /-map 0:a:1/],
    [['-i', 'a.mp4', '-vf', 'scale=iw/2:ih/2', 'o.mp4'], /expression/],
    [['-i', 'a.mp4', '-vf', 'crop=100:100', 'o.mp4'], /crop needs four/],
    [['-i', 'a.mp4', '-vf', 'transpose=3', 'o.mp4'], /flips/],
    [['-i', 'a.mp4', '-pix_fmt', 'yuv444p', 'o.mp4'], /yuv444p/],
    [['-i', 'a.mp4', '-movflags', '+use_metadata_tags', 'o.mp4'], /use_metadata_tags/],
    [['-i', 'a.mp4', '-movflags', '+faststart', 'o.webm'], /only applies to mp4/],
    [['-i', 'a.mp4', '-g', '48', 'o.mp4'], /-g needs -r/],
    [['-i', 'a.mp4', '-ss', '10', '-to', '5', 'o.mp4'], /trim end/],
    [['-i', 'a.mp4', '-an', '-vn', 'o.mp4'], /nothing to write/],
    [['-i', 'a.mp4', '-metadata', 'date=2024', 'o.mp4'], /date/],
    [['-i', 'a.mp4', '-profile:v', 'high', 'o.mp4'], /-profile:v/],
    [['-i', 'a.mp4', '-bsf:v', 'hevc_mp4toannexb', 'o.ts'], /hevc_mp4toannexb/],
    [['-itsoffset', '1', '-i', 'a.mp4', 'o.mp4'], /-itsoffset/],
  ])('%j', (argv, reason) => {
    expect(rejection(argv)).toMatch(reason);
  });

  it('never throws on odd argv (missing value at the end)', () => {
    const t = translateToMediabunny({
      inputs: [{ path: 'a.mp4', raw: ['-i', 'a.mp4'] }],
      outputOpts: ['-b:v'],
      outputPath: 'o.mp4',
      listDevices: false,
      exactSize: false,
    });
    expect(t).toEqual({ ok: false, reason: 'option -b:v is missing its value' });
  });
});

describe('value parsers', () => {
  it('parses ffmpeg time forms', () => {
    expect(parseTime('90')).toBe(90);
    expect(parseTime('1.5s')).toBe(1.5);
    expect(parseTime('1500ms')).toBe(1.5);
    expect(parseTime('01:02:03.5')).toBe(3723.5);
    expect(parseTime('02:03')).toBe(123);
    expect(() => parseTime('soon')).toThrow(/cannot parse time/);
  });

  it('parses bitrates with k/M suffixes', () => {
    expect(parseBitrate('128k')).toBe(128_000);
    expect(parseBitrate('2.5M')).toBe(2_500_000);
    expect(parseBitrate('96000')).toBe(96000);
    expect(() => parseBitrate('fast')).toThrow(/bitrate/);
  });

  it('buckets crf and -q:a onto the five presets', () => {
    expect([15, 20, 26, 32, 45].map(crfToQuality)).toEqual([
      'very_high',
      'high',
      'medium',
      'low',
      'very_low',
    ]);
    expect([0, 2, 5, 7, 9].map(audioQscaleToQuality)).toEqual([
      'very_high',
      'high',
      'medium',
      'low',
      'very_low',
    ]);
  });
});
