/**
 * `ffmpeg` shell command. Runs the WASM build of FFmpeg via
 * `@ffmpeg/ffmpeg`, with the heavy `@ffmpeg/core` artifacts
 * downloaded on demand at first call (see `ffmpeg-wasm.ts`).
 *
 * Two notable paths:
 *
 *  1. **Plain ffmpeg invocation**: argv-style flags + at least one
 *     `-i INPUT` and a trailing output filename. Inputs are read
 *     from the VFS into the FFmpeg in-memory FS, the binary is
 *     invoked with the user's args, and the output file is read
 *     back into the VFS. Log lines from `ffmpeg.on('log')` are
 *     forwarded to stderr so timing and progress are visible.
 *
 *  2. **`-f avfoundation` capture**: when the input format is
 *     `avfoundation` we route through the browser's `getUserMedia`
 *     to grab webcam frames. The macOS-style invocation
 *
 *         ffmpeg -f avfoundation -video_size 1280x720 -framerate 30 \
 *                -i "0" -frames:v 1 -update 1 -y photo.jpg
 *
 *     captures one frame and writes it to `photo.jpg`. With no
 *     `-frames:v 1` and a duration-like `-t`, the same path records
 *     a short clip via `MediaRecorder`. The capture happens
 *     page-side through the panel-RPC bridge when running inside
 *     the kernel DedicatedWorker, or directly when the shell hosts
 *     a real DOM (extension offscreen, standalone non-worker).
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { getFfmpeg } from './ffmpeg-wasm.js';
import {
  captureCamera,
  type CameraCaptureRequest,
  type CameraCaptureResult,
} from '../../ui/panel-rpc-handlers.js';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';

interface MediaDeviceSummary {
  videoinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
  audioinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
}

function ffmpegHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `ffmpeg - WASM build, downloaded on demand

Usage:
  ffmpeg [global-opts] -i input [input-opts] ... output [output-opts]

Common flags pass through to ffmpeg unchanged. Inputs/outputs are
resolved against the current VFS working directory.

Webcam capture (avfoundation-style):
  ffmpeg -f avfoundation -video_size 1280x720 -framerate 30 \\
         -i "0" -frames:v 1 -update 1 -y photo.jpg
  ffmpeg -f avfoundation -i "0" -t 5 clip.webm
  ffmpeg -f avfoundation -i "0:0" -t 5 clip.webm    # video + audio
  ffmpeg -f avfoundation -i ":0" -t 5 audio.webm    # audio only
  ffmpeg -f avfoundation -list_devices true -i ""    # list devices

Avfoundation-specific options:
  -warmup MS       Photo mode: ms to wait for auto-exposure to settle
                   before grabbing the frame. Default 1500. Pass 0 to
                   capture immediately (will look dark / noisy on most
                   webcams because the AE algorithm hasn't converged).
  -exact_size      Use exact:{w,h,frameRate} constraints rather than
                   ideal:. Falls back to ideal: with a warning if the
                   camera can't deliver the requested mode.

Captured streams can be transcoded through the WASM core in the same
invocation. Output options like -c:v, -c:a, -crf, -preset, -pix_fmt,
-vf, -b:v, -b:a, and a mismatched output extension all trigger a
post-capture wasm pass so the produced file matches what the user asked
for (e.g. real H.264 mp4 instead of webm bytes in a .mp4 wrapper).

Notes:
  - First run downloads ~31 MB of ffmpeg-core; subsequent runs reuse
    the cached copy.
  - The browser will prompt for camera/mic permission on first capture.
  - Numeric -i values index into the per-kind enumerateDevices() list,
    matching ffmpeg's native avfoundation device numbering on macOS.
`,
    stderr: '',
    exitCode: 0,
  };
}

function ffmpegVersion(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'ffmpeg (wasm via @ffmpeg/ffmpeg)\n',
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Parse an ffmpeg-style argv into discrete input groups and a
 * trailing output. Captures the flags that matter for the webcam
 * path (`-f`, `-video_size`, `-framerate`, `-t`, `-frames:v`) on
 * the input side, and leaves everything else as opaque pass-through
 * tokens.
 *
 * Exported so unit tests can pin the parsing surface without
 * spinning up the WASM runtime.
 */
export interface ParsedFfmpegInvocation {
  globalOpts: string[];
  inputs: ParsedInput[];
  outputOpts: string[];
  outputPath: string | null;
  listDevices: boolean;
  /** Custom flag: photo warmup in ms (override auto-exposure settle). */
  warmupMs?: number;
  /** Custom flag: use `exact:` getUserMedia constraints. */
  exactSize: boolean;
}

export interface ParsedInput {
  path: string;
  format?: string;
  videoSize?: { width: number; height: number };
  frameRate?: number;
  raw: string[];
}

/**
 * Split an avfoundation-style `-i "videoIdx:audioIdx"` path into its
 * components. Mirrors macOS ffmpeg's parsing:
 *   "0"     → { video: "0" }
 *   "0:1"   → { video: "0", audio: "1" }
 *   ":0"    → { audio: "0" } (audio-only)
 *   "0:"    → { video: "0" } (video-only, redundant)
 *   "Cam0:default" → { video: "Cam0", audio: "default" }
 * Non-avfoundation inputs (regular file paths) return `{ video: path }`
 * unchanged.
 */
export function parseAvfoundationDeviceSpec(spec: string): {
  video?: string;
  audio?: string;
} {
  if (!spec.includes(':')) return { video: spec };
  const idx = spec.indexOf(':');
  const v = spec.slice(0, idx);
  const a = spec.slice(idx + 1);
  return {
    ...(v ? { video: v } : {}),
    ...(a ? { audio: a } : {}),
  };
}

export function parseFfmpegArgs(args: string[]): ParsedFfmpegInvocation {
  const globalOpts: string[] = [];
  const inputs: ParsedInput[] = [];
  const outputOpts: string[] = [];
  let outputPath: string | null = null;
  let listDevices = false;
  let warmupMs: number | undefined;
  let exactSize = false;
  let i = 0;
  let pendingFormat: string | undefined;
  let pendingVideoSize: { width: number; height: number } | undefined;
  let pendingFrameRate: number | undefined;
  let pendingPreInputRaw: string[] = [];

  const takesValue = (flag: string): boolean => {
    // Conservative list of ffmpeg flags that consume a single value.
    // Anything not in the list is treated as a boolean toggle.
    return new Set([
      '-f',
      '-i',
      '-c',
      '-c:v',
      '-c:a',
      '-vf',
      '-af',
      '-filter:v',
      '-filter:a',
      '-filter_complex',
      '-r',
      '-b:v',
      '-b:a',
      '-s',
      '-t',
      '-ss',
      '-to',
      '-pix_fmt',
      '-vcodec',
      '-acodec',
      '-ar',
      '-ac',
      '-frames:v',
      '-frames:a',
      '-q:v',
      '-q:a',
      '-crf',
      '-preset',
      '-tune',
      '-movflags',
      '-map',
      '-metadata',
      '-loglevel',
      '-threads',
      '-video_size',
      '-framerate',
      '-pixel_format',
      '-update',
      '-list_devices',
      '-warmup',
    ]).has(flag);
  };

  while (i < args.length) {
    const tok = args[i];
    if (tok === '-i') {
      const path = args[i + 1];
      if (typeof path !== 'string') {
        throw new Error('ffmpeg: -i requires a path argument');
      }
      inputs.push({
        path,
        format: pendingFormat,
        videoSize: pendingVideoSize,
        frameRate: pendingFrameRate,
        raw: [...pendingPreInputRaw, '-i', path],
      });
      pendingFormat = undefined;
      pendingVideoSize = undefined;
      pendingFrameRate = undefined;
      pendingPreInputRaw = [];
      i += 2;
      continue;
    }
    if (tok === '-f' && typeof args[i + 1] === 'string') {
      pendingFormat = args[i + 1];
      pendingPreInputRaw.push(tok, args[i + 1]);
      i += 2;
      continue;
    }
    if (tok === '-video_size' && typeof args[i + 1] === 'string') {
      const m = /^(\d+)x(\d+)$/.exec(args[i + 1]);
      if (m) pendingVideoSize = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
      pendingPreInputRaw.push(tok, args[i + 1]);
      i += 2;
      continue;
    }
    if (tok === '-framerate' && typeof args[i + 1] === 'string') {
      const n = parseFloat(args[i + 1]);
      if (!Number.isNaN(n)) pendingFrameRate = n;
      pendingPreInputRaw.push(tok, args[i + 1]);
      i += 2;
      continue;
    }
    // avfoundation device enumeration request. ffmpeg writes the
    // device list to stderr and exits non-zero with "Output file is
    // required" if you actually try to run, so we intercept up front.
    if (tok === '-list_devices' && typeof args[i + 1] === 'string') {
      if (/^(true|1|yes)$/i.test(args[i + 1])) listDevices = true;
      pendingPreInputRaw.push(tok, args[i + 1]);
      i += 2;
      continue;
    }
    // Custom flag: photo warmup override (ms).
    if (tok === '-warmup' && typeof args[i + 1] === 'string') {
      const n = parseInt(args[i + 1], 10);
      if (!Number.isNaN(n) && n >= 0) warmupMs = n;
      i += 2;
      continue;
    }
    // Custom flag: switch getUserMedia constraints to `exact:`.
    if (tok === '-exact_size') {
      exactSize = true;
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      if (takesValue(tok)) {
        const value = args[i + 1];
        if (inputs.length === 0) {
          pendingPreInputRaw.push(tok, value);
          globalOpts.push(tok, value);
        } else {
          outputOpts.push(tok, value);
        }
        i += 2;
        continue;
      }
      if (inputs.length === 0) {
        pendingPreInputRaw.push(tok);
        globalOpts.push(tok);
      } else {
        outputOpts.push(tok);
      }
      i += 1;
      continue;
    }
    // Positional: the trailing token is the output path.
    outputPath = tok;
    i += 1;
  }

  return {
    globalOpts,
    inputs,
    outputOpts,
    outputPath,
    listDevices,
    ...(warmupMs !== undefined ? { warmupMs } : {}),
    exactSize,
  };
}

/**
 * True when the invocation should be served by the browser's
 * webcam pipeline instead of the WASM ffmpeg binary. Centralized
 * so tests can assert on the predicate independent of execution.
 */
export function isAvfoundationCapture(parsed: ParsedFfmpegInvocation): boolean {
  return parsed.inputs.some((input) => input.format === 'avfoundation');
}

/**
 * Capture a single frame photo / short clip via getUserMedia and
 * return the resulting bytes + mime. Decides photo vs video based
 * on output options (`-frames:v 1` ⇒ photo; otherwise video).
 *
 * Exported so unit tests can verify routing without exercising the
 * actual browser APIs.
 */
export function buildCameraRequest(parsed: ParsedFfmpegInvocation): {
  request: CameraCaptureRequest;
  outputPath: string;
  /**
   * True when the parsed output options imply a transcode pass
   * (codec selection, filter chain, mismatched container). The
   * caller staging the wasm pipeline uses this to decide whether to
   * write the captured bytes straight to the VFS or to feed them
   * through ffmpeg-core for re-muxing/re-encoding.
   */
  needsTranscode: boolean;
  captureMime: string;
} {
  const input = parsed.inputs.find((i) => i.format === 'avfoundation');
  if (!input) throw new Error('ffmpeg: no avfoundation input found');
  if (!parsed.outputPath) throw new Error('ffmpeg: output path is required');

  const framesIdx = parsed.outputOpts.indexOf('-frames:v');
  const wantsSingleFrame = framesIdx >= 0 && parsed.outputOpts[framesIdx + 1] === '1';
  const updateMode =
    parsed.outputOpts.includes('-update') ||
    parsed.outputOpts[parsed.outputOpts.indexOf('-update') + 1] === '1';
  const tIdx = parsed.outputOpts.indexOf('-t');
  const durationSeconds = tIdx >= 0 ? parseFloat(parsed.outputOpts[tIdx + 1]) : NaN;

  const spec = parseAvfoundationDeviceSpec(input.path);
  const inferredMime = inferOutputMime(parsed.outputPath);
  const isPhotoOutput = /^image\//.test(inferredMime);
  // Audio-only requests collapse to video-mode at the capture layer
  // (MediaRecorder records audio tracks into a webm container).
  const audioOnly = !spec.video && !!spec.audio;
  const photo = !audioOnly && (wantsSingleFrame || updateMode || isPhotoOutput);

  if (photo) {
    const captureMime =
      isPhotoOutput && /^image\/(jpeg|png|webp)$/.test(inferredMime) ? inferredMime : 'image/jpeg';
    return {
      outputPath: parsed.outputPath,
      captureMime,
      needsTranscode:
        outputOptsRequireTranscode(parsed.outputOpts, 'photo') || captureMime !== inferredMime,
      request: {
        mode: 'photo',
        deviceId: spec.video,
        width: input.videoSize?.width,
        height: input.videoSize?.height,
        frameRate: input.frameRate,
        exactSize: parsed.exactSize,
        mimeType: captureMime,
        quality: 0.92,
        ...(parsed.warmupMs !== undefined ? { warmupMs: parsed.warmupMs } : {}),
      },
    };
  }

  // Video (or audio-only). MediaRecorder always emits webm in our
  // implementation, so anything else is a transcode candidate.
  const wantsAudio = audioOnly || !!spec.audio;
  const captureMime = 'video/webm';
  return {
    outputPath: parsed.outputPath,
    captureMime,
    needsTranscode:
      outputOptsRequireTranscode(parsed.outputOpts, 'video') || captureMime !== inferredMime,
    request: {
      mode: 'video',
      deviceId: spec.video,
      ...(wantsAudio ? { captureAudio: true } : {}),
      ...(spec.audio ? { audioDeviceId: spec.audio } : {}),
      width: input.videoSize?.width,
      height: input.videoSize?.height,
      frameRate: input.frameRate,
      exactSize: parsed.exactSize,
      mimeType: captureMime,
      durationMs: Number.isFinite(durationSeconds) ? durationSeconds * 1000 : undefined,
    },
  };
}

/**
 * True when any of the output options imply a re-encode or remux
 * pass beyond what the browser's canvas / MediaRecorder can do
 * directly. Photo path treats filter / pixel-format / quality
 * controls as transcode triggers; video path adds codec / bitrate /
 * preset selection.
 */
function outputOptsRequireTranscode(opts: string[], kind: 'photo' | 'video'): boolean {
  const photoTriggers = new Set([
    '-vf',
    '-filter:v',
    '-filter_complex',
    '-pix_fmt',
    '-q:v',
    '-vcodec',
    '-c:v',
  ]);
  const videoTriggers = new Set([
    '-c',
    '-c:v',
    '-c:a',
    '-vcodec',
    '-acodec',
    '-vf',
    '-af',
    '-filter:v',
    '-filter:a',
    '-filter_complex',
    '-pix_fmt',
    '-pixel_format',
    '-crf',
    '-preset',
    '-tune',
    '-b:v',
    '-b:a',
    '-ar',
    '-ac',
    '-q:v',
    '-q:a',
    '-movflags',
    '-r',
  ]);
  const triggers = kind === 'photo' ? photoTriggers : videoTriggers;
  return opts.some((opt) => triggers.has(opt));
}

function inferOutputMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

function captureExtensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'audio/webm') return 'webm';
  return 'bin';
}

function inferInputName(input: ParsedInput, idx: number): string {
  const slash = input.path.lastIndexOf('/');
  const base = slash >= 0 ? input.path.slice(slash + 1) : input.path;
  // Guard against duplicate names — prefix the index when the
  // user passed the same filename twice (which ffmpeg allows on
  // disk because the cwd context differs but MEMFS collapses).
  return base ? `__in${idx}_${base}` : `__in${idx}.bin`;
}

export function createFfmpegCommand(): Command {
  return defineCommand('ffmpeg', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help')) return ffmpegHelp();
    if (args.includes('-version') || args.includes('--version')) return ffmpegVersion();

    let parsed: ParsedFfmpegInvocation;
    try {
      parsed = parseFfmpegArgs(args);
    } catch (err) {
      return {
        stdout: '',
        stderr: `${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    // `-list_devices true` is a query, not an encode — short-circuit
    // before the output-required check so the user doesn't have to
    // pass a dummy path.
    if (parsed.listDevices && isAvfoundationCapture(parsed)) {
      return runListDevices();
    }

    if (!parsed.outputPath) {
      return {
        stdout: '',
        stderr: 'ffmpeg: at least one output file must be specified\n',
        exitCode: 1,
      };
    }
    if (parsed.inputs.length === 0) {
      return {
        stdout: '',
        stderr: 'ffmpeg: at least one input file must be specified\n',
        exitCode: 1,
      };
    }

    if (isAvfoundationCapture(parsed)) {
      return runAvfoundationCapture(parsed, ctx);
    }

    return runWasmFfmpeg(parsed, ctx);
  });
}

/**
 * Emit a device listing in ffmpeg's avfoundation-style format. Real
 * ffmpeg prints both kinds and exits non-zero with "Output file is
 * required" — we mimic the format but exit 0 because no output was
 * actually expected.
 */
async function runListDevices(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let devices: MediaDeviceSummary;
  try {
    devices = await enumerateMediaDevices();
  } catch (err) {
    return {
      stdout: '',
      stderr: `ffmpeg: failed to enumerate devices: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
  const lines: string[] = [];
  lines.push('[AVFoundation indev @ 0x0] AVFoundation video devices:');
  if (devices.videoinputs.length === 0) {
    lines.push('[AVFoundation indev @ 0x0]   (none)');
  } else {
    devices.videoinputs.forEach((d, idx) => {
      lines.push(`[AVFoundation indev @ 0x0] [${idx}] ${d.label || `Camera ${idx}`}`);
    });
  }
  lines.push('[AVFoundation indev @ 0x0] AVFoundation audio devices:');
  if (devices.audioinputs.length === 0) {
    lines.push('[AVFoundation indev @ 0x0]   (none)');
  } else {
    devices.audioinputs.forEach((d, idx) => {
      lines.push(`[AVFoundation indev @ 0x0] [${idx}] ${d.label || `Microphone ${idx}`}`);
    });
  }
  return { stdout: '', stderr: `${lines.join('\n')}\n`, exitCode: 0 };
}

async function enumerateMediaDevices(): Promise<MediaDeviceSummary> {
  if (
    hasLocalDom() &&
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices?.enumerateDevices
  ) {
    const all = await navigator.mediaDevices.enumerateDevices();
    const map = (d: MediaDeviceInfo): { deviceId: string; label: string; groupId?: string } => ({
      deviceId: d.deviceId,
      label: d.label || '',
      ...(d.groupId ? { groupId: d.groupId } : {}),
    });
    return {
      videoinputs: all.filter((d) => d.kind === 'videoinput').map(map),
      audioinputs: all.filter((d) => d.kind === 'audioinput').map(map),
    };
  }
  const panelRpc = getPanelRpcClient();
  if (!panelRpc) {
    throw new Error('device enumeration requires a browser context');
  }
  return panelRpc.call('enumerate-media-devices', undefined, { timeoutMs: 10_000 });
}

async function runAvfoundationCapture(
  parsed: ParsedFfmpegInvocation,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let plan: ReturnType<typeof buildCameraRequest>;
  try {
    plan = buildCameraRequest(parsed);
  } catch (err) {
    return {
      stdout: '',
      stderr: `${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  let result: CameraCaptureResult;
  try {
    if (hasLocalDom() && typeof navigator !== 'undefined' && navigator.mediaDevices) {
      result = await captureCamera(plan.request);
    } else {
      const panelRpc = getPanelRpcClient();
      if (!panelRpc) {
        return {
          stdout: '',
          stderr:
            'ffmpeg: camera capture requires a browser context — not available in this runtime\n',
          exitCode: 1,
        };
      }
      // Camera capture can take a while when permission has not
      // been granted yet (user has to click "Allow") — give it a
      // generous timeout matching `screencapture`.
      const r = await panelRpc.call('capture-camera', plan.request, {
        timeoutMs: 5 * 60_000,
      });
      result = {
        bytes: r.bytes,
        mimeType: r.mimeType,
        width: r.width,
        height: r.height,
        durationMs: r.durationMs,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/NotAllowedError|Permission denied/i.test(message)) {
      return {
        stdout: '',
        stderr: 'ffmpeg: camera permission denied\n',
        exitCode: 1,
      };
    }
    if (/NotFoundError/i.test(message)) {
      return {
        stdout: '',
        stderr: 'ffmpeg: no camera device found\n',
        exitCode: 1,
      };
    }
    return {
      stdout: '',
      stderr: `ffmpeg: ${message}\n`,
      exitCode: 1,
    };
  }

  const sizeKB = Math.round(result.bytes.byteLength / 1024);
  const dims = `${result.width}x${result.height}`;
  const detail =
    plan.request.mode === 'video' && result.durationMs
      ? `${dims}, ${Math.round(result.durationMs)}ms`
      : dims;

  let finalBytes: Uint8Array = new Uint8Array(result.bytes);
  let transcodeLog = '';
  if (plan.needsTranscode) {
    try {
      const transcoded = await transcodeCapturedBytes({
        bytes: finalBytes,
        captureMime: plan.captureMime,
        outputName: plan.outputPath,
        outputOpts: parsed.outputOpts,
        onLog: (line) => {
          transcodeLog += `${line}\n`;
        },
      });
      // Copy through a fresh ArrayBuffer-backed Uint8Array so the
      // strict ArrayBuffer typing the VFS expects is satisfied (the
      // ffmpeg wrapper occasionally returns a view backed by a
      // SharedArrayBuffer when threading is enabled).
      finalBytes = new Uint8Array(transcoded.byteLength);
      finalBytes.set(transcoded);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: `${transcodeLog}ffmpeg: captured ${detail} (${sizeKB} KB) but transcode failed: ${msg}\n`,
        exitCode: 1,
      };
    }
  }

  const resolvedOutput = ctx.fs.resolvePath(ctx.cwd, plan.outputPath);
  try {
    await ctx.fs.writeFile(resolvedOutput, finalBytes);
  } catch (err) {
    return {
      stdout: '',
      stderr: `ffmpeg: failed to write ${plan.outputPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  const finalKB = Math.round(finalBytes.byteLength / 1024);
  const sizeNote = plan.needsTranscode ? `${sizeKB} KB → ${finalKB} KB` : `${sizeKB} KB`;
  return {
    stdout: '',
    stderr: `${transcodeLog}ffmpeg: captured ${detail} (${sizeNote}) to ${plan.outputPath}\n`,
    exitCode: 0,
  };
}

/**
 * Run the captured photo/video bytes through ffmpeg-core to honor
 * codec / filter / container options the browser-side capture can't
 * satisfy on its own. Inputs are staged into MEMFS under a name
 * matching the capture mime so ffmpeg picks the right demuxer; the
 * output path is reduced to a filename for MEMFS.
 */
async function transcodeCapturedBytes(args: {
  bytes: Uint8Array;
  captureMime: string;
  outputName: string;
  outputOpts: string[];
  onLog: (line: string) => void;
}): Promise<Uint8Array> {
  const inputExt = captureExtensionForMime(args.captureMime);
  const inputName = `__capture.${inputExt}`;
  const outputName = `__out_${args.outputName.split('/').pop() || 'out.bin'}`;

  args.onLog('transcoding captured stream...');
  const ffmpeg = await getFfmpeg({ onProgress: args.onLog });
  const logHandler = (event: { type: string; message: string }): void => {
    args.onLog(event.message);
  };
  ffmpeg.on('log', logHandler);
  try {
    await ffmpeg.writeFile(inputName, args.bytes);
    const argv: string[] = ['-i', inputName, ...args.outputOpts, outputName];
    const exitCode = await ffmpeg.exec(argv);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg-core exited with code ${exitCode}`);
    }
    const out = await ffmpeg.readFile(outputName);
    if (out instanceof Uint8Array) return out;
    if (typeof out === 'string') return new TextEncoder().encode(out);
    throw new Error('ffmpeg-core returned an unknown payload type');
  } finally {
    try {
      ffmpeg.off('log', logHandler);
    } catch {
      /* noop */
    }
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {
      /* noop */
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {
      /* noop */
    }
  }
}

async function runWasmFfmpeg(
  parsed: ParsedFfmpegInvocation,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Validate inputs up front so we don't pay the cold-start cost
  // before realizing the user typo'd a path.
  const resolvedInputs: Array<{ ffmpegName: string; bytes: Uint8Array }> = [];
  for (const [idx, input] of parsed.inputs.entries()) {
    const resolved = ctx.fs.resolvePath(ctx.cwd, input.path);
    if (!(await ctx.fs.exists(resolved))) {
      return {
        stdout: '',
        stderr: `ffmpeg: input file not found: ${input.path}\n`,
        exitCode: 1,
      };
    }
    const bytes = await ctx.fs.readFileBuffer(resolved);
    resolvedInputs.push({
      ffmpegName: inferInputName(input, idx),
      bytes,
    });
  }

  const outputPath = parsed.outputPath!;
  const outputName = `__out_${outputPath.split('/').pop() || 'out.bin'}`;

  let stderr = '';
  let ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>;
  try {
    ffmpeg = await getFfmpeg({
      onProgress: (msg) => {
        stderr += `${msg}\n`;
      },
    });
  } catch (err) {
    return {
      stdout: '',
      stderr: `${stderr}ffmpeg: failed to load wasm: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  const logHandler = (event: { type: string; message: string }): void => {
    stderr += `${event.message}\n`;
  };
  ffmpeg.on('log', logHandler);
  try {
    // Stage inputs into MEMFS.
    for (const input of resolvedInputs) {
      await ffmpeg.writeFile(input.ffmpegName, input.bytes);
    }

    // Rebuild argv with the MEMFS-local input names. Output options
    // and the trailing positional output are passed through as the
    // user wrote them, just with the path rewritten to MEMFS.
    const finalArgs: string[] = [...parsed.globalOpts];
    for (const [idx, input] of parsed.inputs.entries()) {
      // Strip the original -i path and replace with the MEMFS name.
      // Preserve any pre-input options the user provided (`-f`,
      // `-video_size`, …) so user filters survive.
      const ffmpegName = resolvedInputs[idx].ffmpegName;
      const rawWithoutOriginalPath: string[] = [];
      const raw = input.raw;
      for (let k = 0; k < raw.length; k++) {
        if (raw[k] === '-i') {
          rawWithoutOriginalPath.push('-i', ffmpegName);
          k += 1;
          continue;
        }
        rawWithoutOriginalPath.push(raw[k]);
      }
      finalArgs.push(...rawWithoutOriginalPath);
    }
    finalArgs.push(...parsed.outputOpts);
    finalArgs.push(outputName);

    const exitCode = await ffmpeg.exec(finalArgs);
    if (exitCode !== 0) {
      return {
        stdout: '',
        stderr: stderr || `ffmpeg: exited with code ${exitCode}\n`,
        exitCode: exitCode || 1,
      };
    }

    const outputData = await ffmpeg.readFile(outputName);
    const outputBytes =
      outputData instanceof Uint8Array
        ? outputData
        : new TextEncoder().encode(typeof outputData === 'string' ? outputData : '');

    const resolvedOutput = ctx.fs.resolvePath(ctx.cwd, outputPath);
    await ctx.fs.writeFile(resolvedOutput, outputBytes);

    return {
      stdout: '',
      stderr,
      exitCode: 0,
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: `${stderr}ffmpeg: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  } finally {
    try {
      ffmpeg.off('log', logHandler);
    } catch {
      /* noop */
    }
    // Best-effort MEMFS cleanup so repeated invocations don't pile
    // up megabytes of stale media in the wasm heap.
    for (const input of resolvedInputs) {
      try {
        await ffmpeg.deleteFile(input.ffmpegName);
      } catch {
        /* noop */
      }
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {
      /* noop */
    }
  }
}
