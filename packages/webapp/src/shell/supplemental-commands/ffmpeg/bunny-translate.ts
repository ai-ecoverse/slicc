/**
 * ffmpeg argv → mediabunny `Conversion` plan.
 *
 * The `ffmpeg` command keeps its CLI front end but has two engines behind
 * it. mediabunny (WebCodecs, hardware encoders, streaming I/O, no wasm
 * heap) is the fast path for the argv shapes it can express exactly;
 * everything else — filtergraphs, lavfi sources, analysis sinks, image
 * output, codecs the browser lacks — stays on the `@ffmpeg/core` wasm.
 *
 * This module is the pure decision: given a parsed invocation, either a
 * {@link BunnyPlan} that reproduces what ffmpeg would do, or a reason it
 * cannot. It is deliberately conservative — an option with no WebCodecs
 * equivalent is a rejection, never a silent drop — because the caller
 * falls back to the wasm core on rejection, and a wrong "accept" would
 * produce a file that differs from what the agent asked for.
 *
 * No runtime dependency on mediabunny: the plan uses plain data so it can
 * be unit-tested without WebCodecs and so this file stays out of the
 * kernel worker's eager import graph until the first media command.
 */

import type { ParsedFfmpegInvocation } from './run.js';

export type BunnyContainer =
  | 'mp4'
  | 'mov'
  | 'webm'
  | 'mkv'
  | 'mp3'
  | 'wav'
  | 'ogg'
  | 'flac'
  | 'adts'
  | 'mpegts';

export type BunnyVideoCodec = 'avc' | 'hevc' | 'vp8' | 'vp9' | 'av1';

export type BunnyAudioCodec =
  | 'aac'
  | 'opus'
  | 'mp3'
  | 'vorbis'
  | 'flac'
  | 'pcm-s16'
  | 'pcm-s16be'
  | 'pcm-s24'
  | 'pcm-s32'
  | 'pcm-f32'
  | 'pcm-u8'
  | 'pcm-s8'
  | 'ulaw'
  | 'alaw';

/** Mirrors mediabunny's five `QUALITY_*` presets. */
export type BunnyQuality = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';

export interface BunnyCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BunnyVideoPlan {
  discard?: true;
  /**
   * `-c:v copy`: the stream must be copied, never re-encoded. mediabunny
   * would otherwise transcode a codec the container cannot hold; the
   * runner declines that case so the wasm core reports ffmpeg's error.
   */
  copy?: true;
  /**
   * Explicit encoder (`-c:v libx264`). Absent with `copy` absent = ffmpeg's
   * implicit choice, which mediabunny resolves as "copy when the container
   * can hold it, else transcode".
   */
  codec?: BunnyVideoCodec;
  bitrate?: number;
  quality?: BunnyQuality;
  width?: number;
  height?: number;
  fit?: 'fill' | 'contain' | 'cover';
  rotate?: 0 | 90 | 180 | 270;
  crop?: BunnyCrop;
  frameRate?: number;
  /** Seconds between key frames (from `-g N` with a known frame rate). */
  keyFrameInterval?: number;
  /** A bitrate/quality change on the same codec must re-encode, not copy. */
  forceTranscode?: boolean;
}

export interface BunnyAudioPlan {
  discard?: true;
  /** `-c:a copy` — see {@link BunnyVideoPlan.copy}. */
  copy?: true;
  codec?: BunnyAudioCodec;
  bitrate?: number;
  quality?: BunnyQuality;
  numberOfChannels?: number;
  sampleRate?: number;
  forceTranscode?: boolean;
}

export interface BunnyTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  comment?: string;
  description?: string;
}

export interface BunnyPlan {
  container: BunnyContainer;
  video: BunnyVideoPlan;
  audio: BunnyAudioPlan;
  trim?: { start?: number; end?: number };
  tags?: BunnyTags;
  /** MP4/MOV only: `-movflags +faststart` / fragmented. */
  fastStart: false | 'in-memory' | 'fragmented';
}

export type BunnyTranslation = { ok: true; plan: BunnyPlan } | { ok: false; reason: string };

class Reject extends Error {}

/** A declared `never` return so TS narrows after a bare `reject(...)` call. */
function reject(reason: string): never {
  throw new Reject(reason);
}

// ── Option tables ───────────────────────────────────────────────────

/** Toggles that change nothing about the produced file. */
const IGNORED_TOGGLES = new Set([
  '-y',
  '-n',
  '-hide_banner',
  '-nostats',
  '-stats',
  '-nostdin',
  '-sn', // conversions carry no subtitle tracks anyway
  '-dn',
  '-copyts',
]);

/**
 * Value-taking options that only tune the *encoder's effort* or the log,
 * not the result an agent can observe. WebCodecs has no knob for them.
 */
const IGNORED_VALUE_FLAGS = new Set([
  '-loglevel',
  '-v',
  '-threads',
  '-preset',
  '-tune',
  '-max_muxing_queue_size',
  '-strict',
  '-stats_period',
  '-maxrate',
  '-bufsize',
  '-vsync',
  '-fps_mode',
  '-avoid_negative_ts',
]);

const VIDEO_CODECS: Record<string, BunnyVideoCodec | 'copy'> = {
  copy: 'copy',
  libx264: 'avc',
  h264: 'avc',
  avc: 'avc',
  libx265: 'hevc',
  hevc: 'hevc',
  h265: 'hevc',
  libvpx: 'vp8',
  vp8: 'vp8',
  'libvpx-vp9': 'vp9',
  vp9: 'vp9',
  'libaom-av1': 'av1',
  libsvtav1: 'av1',
  librav1e: 'av1',
  av1: 'av1',
};

const AUDIO_CODECS: Record<string, BunnyAudioCodec | 'copy'> = {
  copy: 'copy',
  aac: 'aac',
  libfdk_aac: 'aac',
  libopus: 'opus',
  opus: 'opus',
  libmp3lame: 'mp3',
  mp3: 'mp3',
  libvorbis: 'vorbis',
  vorbis: 'vorbis',
  flac: 'flac',
  pcm_s16le: 'pcm-s16',
  pcm_s16be: 'pcm-s16be',
  pcm_s24le: 'pcm-s24',
  pcm_s32le: 'pcm-s32',
  pcm_f32le: 'pcm-f32',
  pcm_u8: 'pcm-u8',
  pcm_s8: 'pcm-s8',
  pcm_mulaw: 'ulaw',
  pcm_alaw: 'alaw',
};

/** `-f` muxer names and output extensions → container. */
const CONTAINERS: Record<string, BunnyContainer> = {
  mp4: 'mp4',
  m4v: 'mp4',
  m4a: 'mp4',
  ipod: 'mp4',
  mov: 'mov',
  webm: 'webm',
  matroska: 'mkv',
  mkv: 'mkv',
  mka: 'mkv',
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  flac: 'flac',
  adts: 'adts',
  aac: 'adts',
  mpegts: 'mpegts',
  ts: 'mpegts',
  m2ts: 'mpegts',
};

/** Input `-f` demuxers mediabunny can read (anything else is not sniffed). */
const INPUT_FORMATS = new Set([
  'mp4',
  'mov',
  'matroska',
  'webm',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'aac',
  'adts',
  'mpegts',
]);

const BITSTREAM_FILTERS_HANDLED_INTERNALLY = new Set(['h264_mp4toannexb', 'aac_adtstoasc']);

const TAG_KEYS: Record<string, keyof BunnyTags> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  album_artist: 'albumArtist',
  genre: 'genre',
  comment: 'comment',
  description: 'description',
};

// ── Value parsers ───────────────────────────────────────────────────

/** `01:02:03.5`, `63.5`, `90s`, `1500ms` → seconds. */
export function parseTime(raw: string): number {
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(raw);
  if (ms) return Number(ms[1]) / 1000;
  const s = /^(-?\d+(?:\.\d+)?)s?$/.exec(raw);
  if (s) return Number(s[1]);
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(raw);
  if (clock) {
    const [, h = '0', m, sec] = clock;
    return Number(h) * 3600 + Number(m) * 60 + Number(sec);
  }
  return reject(`cannot parse time '${raw}'`);
}

/** `128k`, `2M`, `2.5m`, `96000` → bits per second. */
export function parseBitrate(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(raw);
  if (!m) return reject(`cannot parse bitrate '${raw}'`);
  const scale = m[2] === undefined ? 1 : /k/i.test(m[2]) ? 1000 : 1_000_000;
  return Math.round(Number(m[1]) * scale);
}

function parsePositiveInt(raw: string, what: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return reject(`${what} must be a positive integer`);
  return Number(raw);
}

/** x264 `-crf` (0 lossless … 51 worst) → preset. Default crf is 23. */
export function crfToQuality(crf: number): BunnyQuality {
  if (crf <= 18) return 'very_high';
  if (crf <= 23) return 'high';
  if (crf <= 28) return 'medium';
  if (crf <= 35) return 'low';
  return 'very_low';
}

/** LAME-style `-q:a` (0 best … 9 worst) → preset. */
export function audioQscaleToQuality(q: number): BunnyQuality {
  if (q <= 1) return 'very_high';
  if (q <= 3) return 'high';
  if (q <= 5) return 'medium';
  if (q <= 7) return 'low';
  return 'very_low';
}

/** Strip a trailing stream index (`-c:v:0` → `-c:v`). */
function baseFlag(flag: string): string {
  return flag.replace(/:\d+$/, '');
}

// ── Filters ─────────────────────────────────────────────────────────

function parseScale(args: string, video: BunnyVideoPlan): void {
  const parts = args.split(':');
  const named: Record<string, string> = {};
  const positional: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq >= 0) named[part.slice(0, eq)] = part.slice(eq + 1);
    else positional.push(part);
  }
  const w = named.w ?? named.width ?? positional[0];
  const h = named.h ?? named.height ?? positional[1];
  if (w === undefined || h === undefined) reject('scale needs both a width and a height');
  const dim = (raw: string, what: string): number | undefined => {
    if (raw === '-1' || raw === '-2') return undefined;
    if (!/^\d+$/.test(raw)) reject(`scale ${what} '${raw}' is an expression, not a size`);
    return Number(raw);
  };
  const width = dim(w, 'width');
  const height = dim(h, 'height');
  if (width === undefined && height === undefined) reject('scale keeps both dimensions');
  if (width !== undefined) video.width = width;
  if (height !== undefined) video.height = height;
  // Both given: ffmpeg stretches to exactly WxH. One given: the other
  // follows the aspect ratio, which is mediabunny's default.
  if (width !== undefined && height !== undefined) video.fit = 'fill';
}

function parseCrop(args: string, video: BunnyVideoPlan): void {
  const parts = args.split(':');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) {
    reject('crop needs four integers (w:h:x:y); centred or expression crops stay on wasm');
  }
  const [width, height, left, top] = parts.map(Number);
  video.crop = { left, top, width, height };
}

/** Order bookkeeping for one `-vf` chain. */
interface FilterChain {
  resized: boolean;
  rotated: boolean;
}

function applyScale(args: string, video: BunnyVideoPlan, chain: FilterChain): void {
  if (chain.rotated) reject('scale after transpose: rotation/resize order is not expressible');
  parseScale(args, video);
  chain.resized = true;
}

function applyCrop(args: string, video: BunnyVideoPlan, chain: FilterChain): void {
  if (chain.resized || chain.rotated) {
    reject('crop after scale/transpose: mediabunny crops the source first');
  }
  parseCrop(args, video);
}

function applyTranspose(args: string, video: BunnyVideoPlan, chain: FilterChain): void {
  if (chain.resized || video.crop) {
    reject('transpose combined with scale/crop: rotation order is not expressible');
  }
  if (args === '1' || args === 'clock') video.rotate = 90;
  else if (args === '2' || args === 'cclock') video.rotate = 270;
  else reject(`transpose=${args} flips as well as rotates`);
  chain.rotated = true;
}

function applyFps(args: string, video: BunnyVideoPlan): void {
  video.frameRate = Number(args.replace(/^fps=/, ''));
  if (!(video.frameRate > 0)) reject(`fps '${args}' is not a number`);
}

/**
 * ffmpeg applies a filter chain in the order written; mediabunny applies
 * its options in ITS fixed order (crop the source, then resize, with
 * rotation handled separately). Only chains whose written order matches
 * that pipeline are accepted — `crop,scale` yes, `scale,crop` no — and
 * `transpose` is never combined with a size change, because which of the
 * two happens first changes the output dimensions.
 */
function parseVideoFilter(spec: string, video: BunnyVideoPlan): void {
  const chain: FilterChain = { resized: false, rotated: false };
  for (const filter of spec.split(',')) {
    const eq = filter.indexOf('=');
    const name = (eq >= 0 ? filter.slice(0, eq) : filter).trim();
    const args = eq >= 0 ? filter.slice(eq + 1) : '';
    if (name === 'scale') applyScale(args, video, chain);
    else if (name === 'crop') applyCrop(args, video, chain);
    else if (name === 'transpose') applyTranspose(args, video, chain);
    else if (name === 'fps') applyFps(args, video);
    else if (name === 'format') {
      if (args !== 'yuv420p') reject(`format=${args} has no WebCodecs equivalent`);
    } else reject(`video filter '${name}' has no WebCodecs equivalent`);
  }
}

function parseAudioFilter(spec: string, audio: BunnyAudioPlan): void {
  for (const filter of spec.split(',')) {
    const m = /^aresample=(?:osr=)?(\d+)$/.exec(filter.trim());
    if (!m) reject(`audio filter '${filter}' has no WebCodecs equivalent`);
    audio.sampleRate = Number(m[1]);
  }
}

// ── Output option walk ──────────────────────────────────────────────

interface Walk {
  plan: BunnyPlan;
  container?: BunnyContainer;
  gop?: number;
  frameRateGiven: boolean;
}

function setVideoCodec(walk: Walk, raw: string): void {
  const codec = VIDEO_CODECS[raw];
  if (!codec) reject(`video codec '${raw}' is not available through WebCodecs`);
  if (codec === 'copy') {
    delete walk.plan.video.codec;
    walk.plan.video.copy = true;
  } else {
    delete walk.plan.video.copy;
    walk.plan.video.codec = codec;
  }
}

function setAudioCodec(walk: Walk, raw: string): void {
  const codec = AUDIO_CODECS[raw];
  if (!codec) reject(`audio codec '${raw}' is not available through WebCodecs`);
  if (codec === 'copy') {
    delete walk.plan.audio.codec;
    walk.plan.audio.copy = true;
  } else {
    delete walk.plan.audio.copy;
    walk.plan.audio.codec = codec;
  }
}

function setMovflags(walk: Walk, raw: string): void {
  for (const flag of raw.split('+').filter(Boolean)) {
    if (flag === 'faststart') walk.plan.fastStart = 'in-memory';
    else if (flag === 'frag_keyframe' || flag === 'empty_moov' || flag === 'default_base_moof') {
      walk.plan.fastStart = 'fragmented';
    } else reject(`-movflags ${flag} has no mediabunny equivalent`);
  }
}

function setTag(walk: Walk, raw: string): void {
  const eq = raw.indexOf('=');
  if (eq < 0) reject(`-metadata '${raw}' is not key=value`);
  const key = TAG_KEYS[raw.slice(0, eq)];
  if (!key) reject(`-metadata ${raw.slice(0, eq)} is not a tag mediabunny writes`);
  walk.plan.tags = { ...walk.plan.tags, [key]: raw.slice(eq + 1) };
}

/** Options that take a value. Returns false when `flag` is not one of them. */
function applyValueOption(walk: Walk, flag: string, value: string): boolean {
  const { video, audio } = walk.plan;
  switch (flag) {
    case '-c':
    case '-codec':
      setVideoCodec(walk, value);
      setAudioCodec(walk, value);
      return true;
    case '-c:v':
    case '-vcodec':
    case '-codec:v':
      setVideoCodec(walk, value);
      return true;
    case '-c:a':
    case '-acodec':
    case '-codec:a':
      setAudioCodec(walk, value);
      return true;
    case '-b:v':
    case '-vb':
    case '-b':
      video.bitrate = parseBitrate(value);
      return true;
    case '-b:a':
    case '-ab':
      audio.bitrate = parseBitrate(value);
      return true;
    case '-crf':
      video.quality = crfToQuality(Number(value));
      return true;
    case '-q:a':
    case '-qscale:a':
      audio.quality = audioQscaleToQuality(Number(value));
      return true;
    case '-ac':
      audio.numberOfChannels = parsePositiveInt(value, '-ac');
      return true;
    case '-ar':
      audio.sampleRate = parsePositiveInt(value, '-ar');
      return true;
    case '-r':
    case '-r:v':
      video.frameRate = Number(value);
      if (!(video.frameRate > 0)) reject(`-r '${value}' is not a frame rate`);
      walk.frameRateGiven = true;
      return true;
    case '-g':
      walk.gop = parsePositiveInt(value, '-g');
      return true;
    case '-s':
    case '-s:v': {
      const m = /^(\d+)x(\d+)$/.exec(value);
      if (!m) return reject(`-s '${value}' is not WxH`);
      video.width = Number(m[1]);
      video.height = Number(m[2]);
      video.fit = 'fill';
      return true;
    }
    case '-vf':
    case '-filter:v':
      parseVideoFilter(value, video);
      return true;
    case '-af':
    case '-filter:a':
      parseAudioFilter(value, audio);
      return true;
    case '-pix_fmt':
      if (value !== 'yuv420p') reject(`-pix_fmt ${value} has no WebCodecs equivalent`);
      return true;
    case '-movflags':
      setMovflags(walk, value);
      return true;
    case '-f': {
      const container = CONTAINERS[value];
      if (!container) return reject(`muxer '${value}' is not one mediabunny writes`);
      walk.container = container;
      return true;
    }
    case '-map':
      if (value !== '0') reject(`-map ${value} selects streams; only '-map 0' is expressible`);
      return true;
    case '-metadata':
      setTag(walk, value);
      return true;
    case '-ss':
      walk.plan.trim = { ...walk.plan.trim, start: parseTime(value) };
      return true;
    case '-t': {
      const start = walk.plan.trim?.start ?? 0;
      walk.plan.trim = { ...walk.plan.trim, end: start + parseTime(value) };
      return true;
    }
    case '-to':
      walk.plan.trim = { ...walk.plan.trim, end: parseTime(value) };
      return true;
    case '-bsf':
    case '-bsf:v':
    case '-bsf:a':
      if (!BITSTREAM_FILTERS_HANDLED_INTERNALLY.has(value)) {
        reject(`bitstream filter '${value}' has no mediabunny equivalent`);
      }
      return true;
    default:
      return IGNORED_VALUE_FLAGS.has(flag);
  }
}

function walkOutputOptions(walk: Walk, opts: string[]): void {
  for (let i = 0; i < opts.length; i++) {
    const tok = opts[i];
    const flag = baseFlag(tok);
    if (IGNORED_TOGGLES.has(flag)) continue;
    if (flag === '-shortest') {
      reject('-shortest ends at the shortest stream; mediabunny writes every track to its end');
    }
    if (flag === '-an') {
      walk.plan.audio = { discard: true };
      continue;
    }
    if (flag === '-vn') {
      walk.plan.video = { discard: true };
      continue;
    }
    if (!flag.startsWith('-')) reject(`unexpected positional '${tok}'`);
    const value = opts[i + 1];
    if (value === undefined) reject(`option ${tok} is missing its value`);
    if (!applyValueOption(walk, flag, value)) {
      reject(`option ${tok} has no WebCodecs equivalent`);
    }
    i += 1;
  }
}

/** Per-input options: only seeking/duration and a readable `-f` survive. */
function walkInputOptions(walk: Walk, raw: string[]): void {
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (tok === '-i') {
      i += 1;
      continue;
    }
    if (IGNORED_TOGGLES.has(tok)) continue;
    const value = raw[i + 1];
    if (value === undefined) reject(`input option ${tok} is missing its value`);
    if (tok === '-ss') walk.plan.trim = { ...walk.plan.trim, start: parseTime(value) };
    else if (tok === '-t') {
      const start = walk.plan.trim?.start ?? 0;
      walk.plan.trim = { ...walk.plan.trim, end: start + parseTime(value) };
    } else if (tok === '-to') walk.plan.trim = { ...walk.plan.trim, end: parseTime(value) };
    else if (tok === '-f') {
      if (!INPUT_FORMATS.has(value)) reject(`input demuxer '${value}' is not one mediabunny reads`);
    } else if (!IGNORED_VALUE_FLAGS.has(tok)) {
      reject(`input option ${tok} has no WebCodecs equivalent`);
    }
    i += 1;
  }
}

function containerFromOutput(outputPath: string): BunnyContainer {
  const ext = /\.([A-Za-z0-9]+)$/.exec(outputPath)?.[1]?.toLowerCase();
  const container = ext ? CONTAINERS[ext] : undefined;
  return container ?? reject(`output '${outputPath}' is not a container mediabunny writes`);
}

function finalizePlan(walk: Walk, outputPath: string): BunnyPlan {
  const { plan } = walk;
  plan.container = walk.container ?? containerFromOutput(outputPath);
  if (plan.fastStart !== false && plan.container !== 'mp4' && plan.container !== 'mov') {
    reject('-movflags only applies to mp4/mov output');
  }
  if (walk.gop !== undefined) {
    if (!walk.frameRateGiven) reject('-g needs -r so the interval can be expressed in seconds');
    plan.video.keyFrameInterval = walk.gop / (plan.video.frameRate as number);
  }
  if (
    plan.trim?.start !== undefined &&
    plan.trim.end !== undefined &&
    plan.trim.end <= plan.trim.start
  ) {
    reject('trim end is not after trim start');
  }
  // An explicit encoder (`-c:v libx264`) re-encodes in ffmpeg even when the
  // input already uses that codec; so does a bitrate/quality change. Only
  // the implicit choice (no `-c`) may copy.
  if (
    !plan.video.discard &&
    (plan.video.codec || plan.video.bitrate !== undefined || plan.video.quality)
  ) {
    plan.video.forceTranscode = true;
  }
  if (
    !plan.audio.discard &&
    (plan.audio.codec || plan.audio.bitrate !== undefined || plan.audio.quality)
  ) {
    plan.audio.forceTranscode = true;
  }
  // `-c copy` with a filter or a bitrate is an error in ffmpeg too
  // ("filtering and streamcopy cannot be used together"); mediabunny would
  // quietly transcode instead.
  const v = plan.video;
  if (
    v.copy &&
    (v.width !== undefined ||
      v.height !== undefined ||
      v.crop ||
      v.rotate !== undefined ||
      v.frameRate !== undefined ||
      v.bitrate !== undefined ||
      v.quality)
  ) {
    reject('-c:v copy cannot be combined with video filters or a bitrate');
  }
  const a = plan.audio;
  if (
    a.copy &&
    (a.numberOfChannels !== undefined ||
      a.sampleRate !== undefined ||
      a.bitrate !== undefined ||
      a.quality)
  ) {
    reject('-c:a copy cannot be combined with -ac/-ar or a bitrate');
  }
  if (plan.video.discard && plan.audio.discard) reject('-an with -vn leaves nothing to write');
  return plan;
}

/**
 * Decide whether `parsed` is expressible as one mediabunny conversion.
 * Exactly one real (non-lavfi) input and one output; every option either
 * maps or is rejected with the reason. Never throws.
 */
export function translateToMediabunny(parsed: ParsedFfmpegInvocation): BunnyTranslation {
  try {
    if (parsed.inputs.length !== 1) return { ok: false, reason: 'more than one input' };
    const [input] = parsed.inputs;
    if (input.format === 'lavfi' || input.format === 'concat' || input.format === 'avfoundation') {
      return { ok: false, reason: `-f ${input.format} inputs are synthesized by ffmpeg` };
    }
    if (!parsed.outputPath) return { ok: false, reason: 'no output' };
    const walk: Walk = {
      plan: { container: 'mp4', video: {}, audio: {}, fastStart: false },
      frameRateGiven: false,
    };
    walkInputOptions(walk, input.raw);
    walkOutputOptions(walk, parsed.outputOpts);
    return { ok: true, plan: finalizePlan(walk, parsed.outputPath) };
  } catch (err) {
    if (err instanceof Reject) return { ok: false, reason: err.message };
    throw err;
  }
}
