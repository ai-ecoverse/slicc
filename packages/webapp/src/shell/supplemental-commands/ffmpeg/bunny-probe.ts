/**
 * `ffprobe` on mediabunny's `Input` API.
 *
 * The wasm emulation boots a 31 MB core and scrapes ffmpeg's `Input #0`
 * log banner. mediabunny reads the container index lazily from a `Blob`
 * and answers with typed fields, so a probe costs a few hundred kB of
 * reads and no wasm at all. The result is shaped as the same
 * {@link ProbeInfo} the banner parser produces, so every renderer
 * (`-of json` / `csv` / `default`) and every `-show_entries` selector
 * keeps working unchanged.
 *
 * Returns `null` when mediabunny cannot read the container, and the
 * caller falls back to the wasm probe.
 */

import type * as MediabunnyModule from 'mediabunny';
import type { ProbeFormat, ProbeInfo, ProbeStream } from '../ffprobe/log-parse.js';
import { loadMediabunny } from './bunny-run.js';

/** mediabunny codec ids → ffprobe `codec_name`. */
const CODEC_NAMES: Record<string, string> = {
  avc: 'h264',
  hevc: 'hevc',
  vp8: 'vp8',
  vp9: 'vp9',
  av1: 'av1',
  prores: 'prores',
  aac: 'aac',
  opus: 'opus',
  mp3: 'mp3',
  vorbis: 'vorbis',
  flac: 'flac',
  ac3: 'ac3',
  eac3: 'eac3',
  dts: 'dts',
  'pcm-s16': 'pcm_s16le',
  'pcm-s16be': 'pcm_s16be',
  'pcm-s24': 'pcm_s24le',
  'pcm-s24be': 'pcm_s24be',
  'pcm-s32': 'pcm_s32le',
  'pcm-s32be': 'pcm_s32be',
  'pcm-f32': 'pcm_f32le',
  'pcm-f32be': 'pcm_f32be',
  'pcm-f64': 'pcm_f64le',
  'pcm-f64be': 'pcm_f64be',
  'pcm-u8': 'pcm_u8',
  'pcm-s8': 'pcm_s8',
  ulaw: 'pcm_mulaw',
  alaw: 'pcm_alaw',
  webvtt: 'webvtt',
};

/** Container MIME → the `format_name` real ffprobe prints for it. */
const FORMAT_NAMES: Record<string, string> = {
  'video/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  'audio/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  'video/quicktime': 'mov,mp4,m4a,3gp,3g2,mj2',
  'video/webm': 'matroska,webm',
  'audio/webm': 'matroska,webm',
  'video/x-matroska': 'matroska,webm',
  'audio/x-matroska': 'matroska,webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'video/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'video/mp2t': 'mpegts',
};

const CHANNEL_LAYOUTS: Record<number, string> = {
  1: 'mono',
  2: 'stereo',
  3: '2.1',
  4: 'quad',
  5: '5.0',
  6: '5.1',
  7: '6.1',
  8: '7.1',
};

/** ffprobe prints seconds with six decimals. */
export function formatSeconds(seconds: number): string {
  return seconds.toFixed(6);
}

/**
 * ffprobe frame rates are rationals. Recognise the NTSC family
 * (`30000/1001`, …) exactly, print integers as `N/1`, and approximate
 * everything else to a thousandth.
 */
export function frameRateToRational(fps: number): string {
  if (!(fps > 0) || !Number.isFinite(fps)) return '0/0';
  for (const base of [24, 30, 60, 120]) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.001) return `${base * 1000}/1001`;
  }
  if (Number.isInteger(fps)) return `${fps}/1`;
  const rounded = Math.round(fps * 1000);
  return Number.isInteger(rounded / 1000) ? `${rounded / 1000}/1` : `${rounded}/1000`;
}

function codecName(codec: string | null): string | undefined {
  if (codec === null) return undefined;
  return CODEC_NAMES[codec] ?? codec;
}

async function videoStream(
  track: MediabunnyModule.InputVideoTrack,
  index: number
): Promise<ProbeStream> {
  const stream: ProbeStream = { index, codec_type: 'video', codec_name: codecName(track.codec) };
  stream.width = track.displayWidth;
  stream.height = track.displayHeight;
  try {
    const metrics = await track.computeFrameRateMetrics();
    const rational = frameRateToRational(metrics.underlyingFrameRate ?? metrics.bestGuessFrameRate);
    stream.r_frame_rate = rational;
    stream.avg_frame_rate = frameRateToRational(metrics.averageFrameRate);
  } catch {
    /* a track with no decodable timing keeps the fields absent */
  }
  return stream;
}

function audioStream(track: MediabunnyModule.InputAudioTrack, index: number): ProbeStream {
  const channels = track.numberOfChannels;
  return {
    index,
    codec_type: 'audio',
    codec_name: codecName(track.codec),
    sample_rate: String(track.sampleRate),
    channels,
    channel_layout: CHANNEL_LAYOUTS[channels] ?? `${channels} channels`,
  };
}

async function describeTrack(
  track: MediabunnyModule.InputTrack,
  index: number
): Promise<ProbeStream> {
  const stream: ProbeStream = track.isVideoTrack()
    ? await videoStream(track, index)
    : track.isAudioTrack()
      ? audioStream(track, index)
      : { index, codec_type: track.type, codec_name: codecName(track.codec) };
  try {
    stream.duration = formatSeconds(await track.computeDuration());
  } catch {
    /* live or index-less tracks have no cheap duration */
  }
  const bitrate = await track.getBitrate().catch(() => null);
  if (bitrate !== null && bitrate > 0) stream.bit_rate = String(Math.round(bitrate));
  const language = track.languageCode;
  if (language && language !== 'und') stream.tags = { language };
  return stream;
}

/** Only the string-valued raw tags map onto ffprobe's `format.tags`. */
function stringTags(tags: MediabunnyModule.MetadataTags): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags.raw ?? {})) {
    if (typeof value === 'string') out[key] = value;
  }
  for (const key of ['title', 'artist', 'album', 'genre', 'comment', 'description'] as const) {
    const value = tags[key];
    if (typeof value === 'string' && !(key in out)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Probe `blob` and shape the answer like the wasm banner parser does.
 * `null` when the container is not one mediabunny reads.
 */
export async function probeViaMediabunny(blob: Blob, filename: string): Promise<ProbeInfo | null> {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    let inputFormat: MediabunnyModule.InputFormat;
    try {
      inputFormat = await input.getFormat();
    } catch {
      return null;
    }
    const duration = await input.computeDuration();
    const start = await input.getFirstTimestamp();
    const format: ProbeFormat = {
      filename,
      format_name: FORMAT_NAMES[inputFormat.mimeType] ?? inputFormat.name.toLowerCase(),
      duration: formatSeconds(duration),
      start_time: formatSeconds(start),
    };
    if (duration > 0) format.bit_rate = String(Math.round((blob.size * 8) / duration));
    const tags = stringTags(await input.getMetadataTags().catch(() => ({})));
    if (tags) format.tags = tags;

    const tracks = await input.getTracks();
    const streams: ProbeStream[] = [];
    for (const [index, track] of tracks.entries()) streams.push(await describeTrack(track, index));
    return { format, streams };
  } finally {
    input.dispose();
  }
}
