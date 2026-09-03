/**
 * Execute a {@link BunnyPlan} with mediabunny.
 *
 * mediabunny is imported lazily — it is ~660 kB minified and must not
 * ride the kernel worker's eager import graph — and only ever from here
 * and `bunny-probe.ts`, so the dependency stays one `import()` away from
 * the boot path.
 *
 * Three outcomes, kept distinct because the caller treats them
 * differently:
 *
 * - `declined`: mediabunny cannot do this job *before any work started* —
 *   the container is not one it reads, or a track has no decodable /
 *   encodable codec in this browser. The caller falls back to the wasm
 *   core, which either does the job or reports ffmpeg's own error.
 * - `failed`: the conversion started and died. Falling back would redo
 *   minutes of work for what is usually a broken input, so this is the
 *   command's exit code.
 * - `done`: the encoded file, still in memory. (Streaming the output to
 *   disk needs a VFS write stream; see docs/webapp-details.md.)
 */

import type * as MediabunnyModule from 'mediabunny';
import type { BunnyAudioPlan, BunnyPlan, BunnyQuality, BunnyVideoPlan } from './bunny-translate.js';

type Mediabunny = typeof MediabunnyModule;

export type BunnyRunResult =
  | { kind: 'done'; bytes: Uint8Array; summary: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'failed'; message: string };

let mediabunnyPromise: Promise<Mediabunny> | null = null;

/** Shared lazy import, so `ffmpeg` and `ffprobe` load the module once. */
export function loadMediabunny(): Promise<Mediabunny> {
  mediabunnyPromise ??= import('mediabunny').catch((err) => {
    mediabunnyPromise = null;
    throw err;
  });
  return mediabunnyPromise;
}

function qualityOf(mb: Mediabunny, level: BunnyQuality): MediabunnyModule.Quality {
  switch (level) {
    case 'very_low':
      return mb.QUALITY_VERY_LOW;
    case 'low':
      return mb.QUALITY_LOW;
    case 'medium':
      return mb.QUALITY_MEDIUM;
    case 'high':
      return mb.QUALITY_HIGH;
    case 'very_high':
      return mb.QUALITY_VERY_HIGH;
  }
}

function outputFormatFor(mb: Mediabunny, plan: BunnyPlan): MediabunnyModule.OutputFormat {
  switch (plan.container) {
    case 'mp4':
      return new mb.Mp4OutputFormat({ fastStart: plan.fastStart });
    case 'mov':
      return new mb.MovOutputFormat({ fastStart: plan.fastStart });
    case 'webm':
      return new mb.WebMOutputFormat();
    case 'mkv':
      return new mb.MkvOutputFormat();
    case 'mp3':
      return new mb.Mp3OutputFormat();
    case 'wav':
      return new mb.WavOutputFormat();
    case 'ogg':
      return new mb.OggOutputFormat();
    case 'flac':
      return new mb.FlacOutputFormat();
    case 'adts':
      return new mb.AdtsOutputFormat();
    case 'mpegts':
      return new mb.MpegTsOutputFormat();
  }
}

/** Exported for unit tests: the plan → mediabunny option mapping. */
export function videoOptionsFor(
  mb: Mediabunny,
  video: BunnyVideoPlan
): MediabunnyModule.ConversionVideoOptions {
  if (video.discard) return { discard: true };
  const out: MediabunnyModule.ConversionVideoOptions = {};
  if (video.codec) out.codec = video.codec;
  if (video.bitrate !== undefined) out.bitrate = video.bitrate;
  else if (video.quality) out.bitrate = qualityOf(mb, video.quality);
  if (video.width !== undefined) out.width = video.width;
  if (video.height !== undefined) out.height = video.height;
  if (video.fit) out.fit = video.fit;
  if (video.rotate !== undefined) out.rotate = video.rotate;
  if (video.crop) out.crop = video.crop;
  if (video.frameRate !== undefined) out.frameRate = video.frameRate;
  if (video.keyFrameInterval !== undefined) out.keyFrameInterval = video.keyFrameInterval;
  if (video.forceTranscode) out.forceTranscode = true;
  return out;
}

/** Exported for unit tests: the plan → mediabunny option mapping. */
export function audioOptionsFor(
  mb: Mediabunny,
  audio: BunnyAudioPlan
): MediabunnyModule.ConversionAudioOptions {
  if (audio.discard) return { discard: true };
  const out: MediabunnyModule.ConversionAudioOptions = {};
  if (audio.codec) out.codec = audio.codec;
  if (audio.bitrate !== undefined) out.bitrate = audio.bitrate;
  else if (audio.quality) out.bitrate = qualityOf(mb, audio.quality);
  if (audio.numberOfChannels !== undefined) out.numberOfChannels = audio.numberOfChannels;
  if (audio.sampleRate !== undefined) out.sampleRate = audio.sampleRate;
  if (audio.forceTranscode) out.forceTranscode = true;
  return out;
}

function describeDiscards(discarded: readonly MediabunnyModule.DiscardedTrack[]): string {
  return discarded
    .map((d) => `${d.track.type} track ${d.track.id}: ${d.reason.replace(/_/g, ' ')}`)
    .join('; ');
}

/**
 * Run the plan over `input`. `onLog` receives ffmpeg-style progress lines
 * for stderr; they are throttled to whole-percent steps so a long encode
 * does not flood the 40 KB tool-output cap.
 */
export async function runViaMediabunny(args: {
  plan: BunnyPlan;
  input: Blob;
  onLog: (line: string) => void;
}): Promise<BunnyRunResult> {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(args.input), formats: mb.ALL_FORMATS });
  try {
    let format: MediabunnyModule.InputFormat;
    try {
      format = await input.getFormat();
    } catch (err) {
      return {
        kind: 'declined',
        reason: `input is not a container mediabunny reads (${message(err)})`,
      };
    }

    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: outputFormatFor(mb, args.plan), target });
    let conversion: MediabunnyModule.Conversion;
    try {
      conversion = await mb.Conversion.init({
        input,
        output,
        video: videoOptionsFor(mb, args.plan.video),
        audio: audioOptionsFor(mb, args.plan.audio),
        ...(args.plan.trim ? { trim: args.plan.trim } : {}),
        ...(args.plan.tags ? { tags: args.plan.tags } : {}),
        showWarnings: false,
      });
    } catch (err) {
      return { kind: 'declined', reason: `mediabunny rejected the conversion (${message(err)})` };
    }

    // A track the USER dropped (`-an`, `-vn`) is fine. Anything mediabunny
    // dropped on its own — undecodable source, no encoder in this browser,
    // more tracks than the container holds — would silently produce a
    // different file than ffmpeg would; let the wasm core have it instead.
    const involuntary = conversion.discardedTracks.filter((d) => d.reason !== 'discarded_by_user');
    if (!conversion.isValid || involuntary.length > 0) {
      return {
        kind: 'declined',
        reason: involuntary.length > 0 ? describeDiscards(involuntary) : 'no track can be written',
      };
    }

    let lastPercent = -1;
    conversion.onProgress = (progress) => {
      const percent = Math.floor(progress * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      args.onLog(`progress: ${percent}%`);
    };
    args.onLog(
      `mediabunny: ${format.name} → ${args.plan.container}, ${conversion.utilizedTracks.length} track(s)`
    );
    try {
      await conversion.execute();
    } catch (err) {
      return { kind: 'failed', message: `mediabunny conversion failed: ${message(err)}` };
    }
    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) {
      return { kind: 'failed', message: 'mediabunny produced an empty file' };
    }
    return {
      kind: 'done',
      bytes: new Uint8Array(buffer),
      summary: `${conversion.utilizedTracks.map((t) => t.type).join('+')} → ${args.plan.container}`,
    };
  } finally {
    input.dispose();
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
