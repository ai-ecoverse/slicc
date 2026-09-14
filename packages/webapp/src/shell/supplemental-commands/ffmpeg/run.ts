import type { CommandContext, defineCommand } from 'just-bash';

import { getLeaderPermissionsSurface } from '../../../base/permissions-surface-registry.js';
import {
  getPanelRpcClient,
  hasLocalDom,
  type PermissionRpcKind,
} from '../../../kernel/panel-rpc.js';
import type {
  CameraCaptureRequest,
  CameraCaptureResult,
} from '../../../kernel/panel-rpc-camera-types.js';
import { captureViaPopup, isExtensionFloat } from '../extension-media-capture.js';
import {
  describeFfmpegCore,
  FFMPEG_CORE_MT_PACKAGE,
  ffmpegCoreNotInstalledMessage,
  getFfmpeg,
  type IpkResolutionContext,
  isCoreFault,
  loadedFfmpegCorePackage,
  recycleFfmpeg,
  tryLoadFfmpegCoreFromNodeModules,
} from '../ffmpeg-wasm.js';
import { ffmpegCoreFromEnv } from './engine.js';
import { bytesToBlob, readInputBlob } from './input-blob.js';
import {
  deleteStagedFile,
  mountStagedInputs,
  newStage,
  type StagedFile,
  type StageNames,
  stagedBasename,
  stagedOutputName,
  stagedPath,
  unmountStagedInputs,
} from './staging.js';

type RuntimeCtx = Parameters<Parameters<typeof defineCommand>[1]>[1];

interface MediaDeviceSummary {
  videoinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
  audioinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
}

function ffmpegHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `ffmpeg - two engines behind the ffmpeg CLI

Usage:
  ffmpeg [global-opts] -i input [input-opts] ... output [output-opts]

Common flags pass through to ffmpeg unchanged. Inputs/outputs are
resolved against the current VFS working directory.

Engines (chosen automatically; stderr names the one that ran):
  mediabunny   WebCodecs (hardware encoders, streams from disk, nothing
               to install). Takes one-input → one-output jobs whose
               every option it can express: remux, -c copy, transcode to
               h264/hevc/vp8/vp9/av1 + aac/opus/mp3/vorbis/flac/pcm,
               -ss/-t/-to, -vf crop,scale,fps (in that order; transpose
               only on its own), -s, -r/-g, -ac/-ar, -an/-vn,
               -b:v/-b:a/-crf/-q:a, -movflags, -metadata.
               Without an explicit -c, streams the container can hold are
               copied rather than re-encoded; an explicit encoder always
               re-encodes; -c copy never re-encodes (a codec the container
               cannot hold falls to the wasm core, which fails like ffmpeg).
  wasm         @ffmpeg/core (ipk-installed; see -version). Everything
               else: lavfi sources, -f concat, filtergraphs, -f null
               analysis sinks, image/GIF output, codecs the browser lacks.
               FFMPEG_CORE=mt opts into @ffmpeg/core-mt on a cross-origin-
               isolated leader: multi-threaded, SINGLE-INPUT jobs only
               (multi-input deadlocks and is refused), -threads/-filter_threads
               capped unless you pass them.
  FFMPEG_ENGINE=wasm ffmpeg ...        force byte-identical ffmpeg behaviour
  FFMPEG_ENGINE=mediabunny ffmpeg ...  fail (and say why) instead of falling back

Concatenating (concat demuxer):
  printf "file 'a.mp4'\\nfile 'b.mp4'\\n" > list.txt
  ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4

Files named inside the list are read from the VFS too, resolved
against the LIST FILE's directory. As in ffmpeg, absolute and
parent-traversing members need -safe 0. The \`concat:\` protocol
form (-i "concat:a.ts|b.ts") is not supported — use -f concat.

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

Analysis sinks (no output file — results are on stderr):
  ffmpeg -i in.mp4 -af silencedetect=noise=-30dB:d=0.5 -f null -
  ffmpeg -i in.mp4 -af loudnorm=print_format=json -f null /dev/null
  ffmpeg -i in.mp4 -af loudnorm /dev/null
  With output \`-\` or \`/dev/null\`, the wrapper skips VFS writeback
  and returns the core log (filter measurements) on stderr. \`-\`
  requires \`-f null\` (stdout is not emulated). Bare \`/dev/null\`
  is accepted and gets \`-f null\` injected (MEMFS has no /dev/null).

Notes:
  - The wasm engine needs an ipk-installed core: \`ipk add -g @ffmpeg/core@<pinned>\`
    (\`@ffmpeg/core-mt\` for the FFMPEG_CORE=mt opt-in); \`ffmpeg -version\`
    prints which one is loaded. Inputs are mounted lazily (never copied into
    the wasm heap); only the output is buffered.
  - The browser will prompt for camera/mic permission on first capture.
  - Numeric -i values index into the per-kind enumerateDevices() list,
    matching ffmpeg's native avfoundation device numbering on macOS.
`,
    stderr: '',
    exitCode: 0,
  };
}

async function ffmpegVersion(
  ctx: CommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const preferMt = ffmpegCoreFromEnv(ctx.env) === 'mt';
  const loaded = await tryLoadFfmpegCoreFromNodeModules(
    createIpkContextFromCtx(ctx),
    undefined,
    preferMt
  );
  if (!loaded) {
    return {
      stdout: '',
      stderr: `ffmpeg: ${ffmpegCoreNotInstalledMessage(preferMt)}\n`,
      exitCode: 1,
    };
  }
  return {
    stdout: `ffmpeg (wasm via @ffmpeg/ffmpeg)\ncore: ${describeFfmpegCore(loaded)}\n`,
    stderr: '',
    exitCode: 0,
  };
}

export interface ParsedFfmpegInvocation {
  inputs: ParsedInput[];

  outputOpts: string[];
  outputPath: string | null;
  listDevices: boolean;

  warmupMs?: number;

  exactSize: boolean;
}

export interface ParsedInput {
  path: string;
  format?: string;
  videoSize?: { width: number; height: number };
  frameRate?: number;
  raw: string[];
}

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

const VALUE_TAKING_FLAGS = new Set([
  '-f',
  '-safe',
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

  '-bsf',
  '-bsf:v',
  '-bsf:a',

  '-profile:v',
  '-level',
  '-g',
  '-keyint_min',
  '-sc_threshold',
  '-max_muxing_queue_size',
  '-fflags',
  '-avoid_negative_ts',
  '-start_number',
  '-strict',
  '-vsync',
  '-fps_mode',
  '-async',
  '-disposition',
  '-map_metadata',
  '-c:s',
  '-scodec',
  '-ab',
  '-aspect',
]);

const BOOLEAN_FLAGS = new Set([
  '-y',
  '-n',
  '-vn',
  '-an',
  '-sn',
  '-dn',
  '-re',
  '-stats',
  '-nostats',
  '-nostdin',
  '-shortest',
  '-copyts',
  '-hide_banner',
  '-autorotate',
  '-noautorotate',
  '-ignore_unknown',
  '-exact_size',
  '-bitexact',
  '-xerror',
  '-benchmark',
  '-benchmark_all',
  '-dump',
  '-hex',
  '-stdin',
  '-noautoscale',
  '-accurate_seek',
  '-noaccurate_seek',
  '-fix_sub_duration',
  '-recast_media',
]);

interface ParseState {
  inputs: ParsedInput[];
  outputOpts: string[];
  outputPath: string | null;
  listDevices: boolean;
  warmupMs?: number;
  exactSize: boolean;
  pendingOpts: string[];
  pendingFormat?: string;
  pendingVideoSize?: { width: number; height: number };
  pendingFrameRate?: number;
}

function newParseState(): ParseState {
  return {
    inputs: [],
    outputOpts: [],
    outputPath: null,
    listDevices: false,
    exactSize: false,
    pendingOpts: [],
  };
}

function requireValueAt(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (typeof v !== 'string') throw new Error(`ffmpeg: ${flag} requires a value`);
  return v;
}

function handleInputToken(state: ParseState, args: string[], i: number): number {
  const path = requireValueAt(args, i, '-i');
  state.inputs.push({
    path,
    format: state.pendingFormat,
    videoSize: state.pendingVideoSize,
    frameRate: state.pendingFrameRate,
    raw: [...state.pendingOpts, '-i', path],
  });
  state.pendingFormat = undefined;
  state.pendingVideoSize = undefined;
  state.pendingFrameRate = undefined;
  state.pendingOpts = [];
  return i + 2;
}

function handleVideoSizeToken(state: ParseState, args: string[], i: number): number {
  const value = requireValueAt(args, i, '-video_size');
  const m = /^(\d+)x(\d+)$/.exec(value);
  if (m) state.pendingVideoSize = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  state.pendingOpts.push('-video_size', value);
  return i + 2;
}

function handleFramerateToken(state: ParseState, args: string[], i: number): number {
  const value = requireValueAt(args, i, '-framerate');
  const n = parseFloat(value);
  if (!Number.isNaN(n)) state.pendingFrameRate = n;
  state.pendingOpts.push('-framerate', value);
  return i + 2;
}

function handleListDevicesToken(state: ParseState, args: string[], i: number): number {
  const value = requireValueAt(args, i, '-list_devices');
  if (/^(true|1|yes)$/i.test(value)) state.listDevices = true;
  state.pendingOpts.push('-list_devices', value);
  return i + 2;
}

function handleWarmupToken(state: ParseState, args: string[], i: number): number {
  const value = requireValueAt(args, i, '-warmup');
  const n = parseInt(value, 10);
  if (!Number.isNaN(n) && n >= 0) state.warmupMs = n;
  return i + 2;
}

function hasLaterPositional(args: string[], from: number): boolean {
  for (let i = from; i < args.length; i++) {
    const tok = args[i];

    if (!tok.startsWith('-') || tok === '-') return true;
    if (VALUE_TAKING_FLAGS.has(tok)) i += 1;
  }
  return false;
}

function unknownFlagTakesValue(args: string[], i: number): boolean {
  const next = args[i + 1];
  if (typeof next !== 'string') return false;
  if (next.startsWith('-')) return false;
  return hasLaterPositional(args, i + 2);
}

function handleGenericOptionToken(
  state: ParseState,
  args: string[],
  i: number,
  tok: string
): number {
  if (VALUE_TAKING_FLAGS.has(tok)) {
    const value = requireValueAt(args, i, tok);
    state.pendingOpts.push(tok, value);
    return i + 2;
  }
  if (!BOOLEAN_FLAGS.has(tok) && unknownFlagTakesValue(args, i)) {
    state.pendingOpts.push(tok, args[i + 1]);
    return i + 2;
  }
  state.pendingOpts.push(tok);
  return i + 1;
}

function handlePositionalToken(state: ParseState, tok: string, i: number): number {
  state.outputPath = tok;
  state.outputOpts = state.pendingOpts;
  state.pendingOpts = [];
  return i + 1;
}

export function parseFfmpegArgs(args: string[]): ParsedFfmpegInvocation {
  const state = newParseState();
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (tok === '-i') {
      i = handleInputToken(state, args, i);
      continue;
    }
    if (tok === '-f') {
      const value = requireValueAt(args, i, '-f');
      state.pendingFormat = value;
      state.pendingOpts.push('-f', value);
      i += 2;
      continue;
    }
    if (tok === '-video_size') {
      i = handleVideoSizeToken(state, args, i);
      continue;
    }
    if (tok === '-framerate') {
      i = handleFramerateToken(state, args, i);
      continue;
    }

    if (tok === '-list_devices') {
      i = handleListDevicesToken(state, args, i);
      continue;
    }

    if (tok === '-warmup') {
      i = handleWarmupToken(state, args, i);
      continue;
    }

    if (tok === '-exact_size') {
      state.exactSize = true;
      i += 1;
      continue;
    }

    if (tok === '-' && hasNullMuxer(state.pendingOpts)) {
      i = handlePositionalToken(state, tok, i);
      continue;
    }
    if (tok.startsWith('-')) {
      i = handleGenericOptionToken(state, args, i, tok);
      continue;
    }
    i = handlePositionalToken(state, tok, i);
  }

  return {
    inputs: state.inputs,
    outputOpts: state.outputOpts,
    outputPath: state.outputPath,
    listDevices: state.listDevices,
    ...(state.warmupMs !== undefined ? { warmupMs: state.warmupMs } : {}),
    exactSize: state.exactSize,
  };
}

export function isAvfoundationCapture(parsed: ParsedFfmpegInvocation): boolean {
  return parsed.inputs.some((input) => input.format === 'avfoundation');
}

const ANALYSIS_SINK_TOKENS = new Set(['-', '/dev/null']);

function hasNullMuxer(outputOpts: string[]): boolean {
  for (let i = 0; i < outputOpts.length - 1; i++) {
    if (outputOpts[i] === '-f' && outputOpts[i + 1] === 'null') return true;
  }
  return false;
}

export function isAnalysisSink(parsed: ParsedFfmpegInvocation): boolean {
  const out = parsed.outputPath;
  if (out === null || !ANALYSIS_SINK_TOKENS.has(out)) return false;
  if (out === '/dev/null') return true;
  return hasNullMuxer(parsed.outputOpts);
}

export function ensureNullMuxerOpts(outputOpts: string[]): string[] {
  if (hasNullMuxer(outputOpts)) return outputOpts;
  return [...outputOpts, '-f', 'null'];
}

export function createIpkContextFromCtx(ctx: CommandContext): IpkResolutionContext {
  return {
    reader: {
      exists: (path) => ctx.fs.exists(path),
      isDirectory: async (path) => {
        try {
          return (await ctx.fs.stat(path)).isDirectory;
        } catch {
          return false;
        }
      },
      readFile: (path) => ctx.fs.readFile(path),
    },
    readBytes: (path) => ctx.fs.readFileBuffer(path),
    fromDir: ctx.cwd,
  };
}

export function permissionKindsFor(req: CameraCaptureRequest): PermissionRpcKind[] {
  const kinds: PermissionRpcKind[] = [];
  const wantsVideo = req.mode === 'photo' || req.captureVideo !== false;
  if (wantsVideo) kinds.push('camera');
  if (req.mode === 'video' && req.captureAudio) kinds.push('microphone');
  return kinds;
}

function describeKindsForPrompt(kinds: PermissionRpcKind[]): string {
  if (kinds.length === 0) return 'media devices';
  if (kinds.length === 1) return kinds[0];
  return `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;
}

function stopProbeStreamTracks(grants: ReadonlyArray<unknown>): void {
  for (const grant of grants) {
    const stream = (grant as { stream?: MediaStream }).stream;
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
}

async function tryPageRealmCapturePermission(
  kinds: PermissionRpcKind[],
  description: string
): Promise<{ ok: true } | { ok: false; message: string } | null> {
  const surface = getLeaderPermissionsSurface();
  if (!surface) return null;
  try {
    const result = await surface.prompt({ kinds, description, skipIfGranted: true });
    stopProbeStreamTracks(result.grants);
    if (result.status === 'granted') return { ok: true };
    const detail = result.message ? `: ${result.message}` : '';
    return { ok: false, message: `${result.reason ?? result.status}${detail}` };
  } catch {
    return null;
  }
}

export async function requestCapturePermission(
  kinds: PermissionRpcKind[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (kinds.length === 0) return { ok: true };
  const description = `ffmpeg is requesting access to your ${describeKindsForPrompt(kinds)}.`;

  const pageResult = await tryPageRealmCapturePermission(kinds, description);
  if (pageResult) return pageResult;

  const panelRpc = getPanelRpcClient();
  if (panelRpc) {
    try {
      await panelRpc.call(
        'permission-request',
        { kinds, description, skipIfGranted: true },
        { timeoutMs: 5 * 60_000 }
      );
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (/permission surface unavailable/i.test(message)) {
        return { ok: true };
      }
      return { ok: false, message };
    }
  }

  return { ok: true };
}

export function buildCameraRequest(parsed: ParsedFfmpegInvocation): {
  request: CameraCaptureRequest;
  outputPath: string;

  needsTranscode: boolean;
  captureMime: string;
} {
  const input = parsed.inputs.find((i) => i.format === 'avfoundation');
  if (!input) throw new Error('ffmpeg: no avfoundation input found');
  if (!parsed.outputPath) throw new Error('ffmpeg: output path is required');

  const framesIdx = parsed.outputOpts.indexOf('-frames:v');
  const wantsSingleFrame = framesIdx >= 0 && parsed.outputOpts[framesIdx + 1] === '1';

  const updateIdx = parsed.outputOpts.indexOf('-update');
  const updateMode = updateIdx >= 0 && parsed.outputOpts[updateIdx + 1] === '1';
  const tIdx = parsed.outputOpts.indexOf('-t');
  const durationSeconds = tIdx >= 0 ? parseFloat(parsed.outputOpts[tIdx + 1]) : NaN;

  const spec = parseAvfoundationDeviceSpec(input.path);
  const inferredMime = inferOutputMime(parsed.outputPath);
  const isPhotoOutput = /^image\//.test(inferredMime);

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
      captureVideo: !audioOnly,
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

  return base ? `__in${idx}_${base}` : `__in${idx}.bin`;
}

export async function runFfmpeg(args: string[], ctx: RuntimeCtx): Promise<CmdResult> {
  if (args.length === 0 || args.includes('--help')) return ffmpegHelp();
  if (args.includes('-version') || args.includes('--version')) return ffmpegVersion(ctx);

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
}

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

type CmdResult = { stdout: string; stderr: string; exitCode: number };

async function captureViaExtensionPopup(
  plan: ReturnType<typeof buildCameraRequest>
): Promise<CameraCaptureResult> {
  const popup = await captureViaPopup({ kind: 'camera', ...plan.request });
  const buf = new ArrayBuffer(popup.bytes.byteLength);
  new Uint8Array(buf).set(popup.bytes);
  return {
    bytes: buf,
    mimeType: popup.mimeType,
    width: popup.width,
    height: popup.height,
    ...(popup.durationMs !== undefined ? { durationMs: popup.durationMs } : {}),
  };
}

async function captureViaPanelRpc(
  plan: ReturnType<typeof buildCameraRequest>
): Promise<CameraCaptureResult | null> {
  const panelRpc = getPanelRpcClient();
  if (!panelRpc) return null;

  const r = await panelRpc.call('capture-camera', plan.request, { timeoutMs: 5 * 60_000 });
  return {
    bytes: r.bytes,
    mimeType: r.mimeType,
    width: r.width,
    height: r.height,
    durationMs: r.durationMs,
  };
}

async function performCameraCapture(
  plan: ReturnType<typeof buildCameraRequest>
): Promise<{ result: CameraCaptureResult } | { error: CmdResult }> {
  try {
    if (isExtensionFloat()) {
      return { result: await captureViaExtensionPopup(plan) };
    }
    const r = await captureViaPanelRpc(plan);
    if (!r) {
      return {
        error: {
          stdout: '',
          stderr:
            'ffmpeg: camera capture requires a browser context — not available in this runtime\n',
          exitCode: 1,
        },
      };
    }
    return { result: r };
  } catch (err) {
    return { error: { stdout: '', stderr: formatCaptureError(err), exitCode: 1 } };
  }
}

function formatCaptureError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/NotAllowedError|Permission denied/i.test(message)) {
    return 'ffmpeg: camera permission denied\n';
  }
  if (/NotFoundError/i.test(message)) return 'ffmpeg: no camera device found\n';
  return `ffmpeg: ${message}\n`;
}

async function runAvfoundationCapture(
  parsed: ParsedFfmpegInvocation,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1]
): Promise<CmdResult> {
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

  const permKinds = permissionKindsFor(plan.request);
  const permResult = await requestCapturePermission(permKinds);
  if (!permResult.ok) {
    return {
      stdout: '',
      stderr: `ffmpeg: camera permission denied (${permResult.message})\n`,
      exitCode: 1,
    };
  }

  const captured = await performCameraCapture(plan);
  if ('error' in captured) return captured.error;
  const result = captured.result;

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
        ipk: createIpkContextFromCtx(ctx),
        onLog: (line) => {
          transcodeLog += `${line}\n`;
        },
      });

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

async function transcodeCapturedBytes(args: {
  bytes: Uint8Array;
  captureMime: string;
  outputName: string;
  outputOpts: string[];
  ipk: IpkResolutionContext;
  onLog: (line: string) => void;
}): Promise<Uint8Array> {
  const stage = newStage();
  const inputBase = `capture.${captureExtensionForMime(args.captureMime)}`;
  const inputName = stagedPath(stage, inputBase);
  const outputName = stagedOutputName(stage, args.outputName);

  args.onLog('transcoding captured stream...');
  const ffmpeg = await getFfmpeg({ onProgress: args.onLog, ipk: args.ipk });
  const logHandler = (event: { type: string; message: string }): void => {
    args.onLog(event.message);
  };
  ffmpeg.on('log', logHandler);
  let faulted = false;
  try {
    await mountStagedInputs(ffmpeg, stage, [{ name: inputBase, data: bytesToBlob(args.bytes) }]);
    const argv: string[] = ['-i', inputName, ...args.outputOpts, outputName];
    const exitCode = await ffmpeg.exec(argv);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg-core exited with code ${exitCode}`);
    }
    const out = await ffmpeg.readFile(outputName);
    if (out instanceof Uint8Array) return out;
    if (typeof out === 'string') return new TextEncoder().encode(out);
    throw new Error('ffmpeg-core returned an unknown payload type');
  } catch (err) {
    if (isCoreFault(err)) {
      faulted = true;
      recycleFfmpeg(ffmpeg);
    }
    throw err;
  } finally {
    try {
      ffmpeg.off('log', logHandler);
    } catch {}
    if (!faulted) {
      try {
        await unmountStagedInputs(ffmpeg, stage);
        await deleteStagedFile(ffmpeg, outputName);
      } catch {}
    }
  }
}

interface ResolvedInput {
  ffmpegName: string;

  data: Blob | null;

  virtual: boolean;

  extraFiles?: Array<{ ffmpegName: string; data: Blob }>;
}

function isConcatInput(input: ParsedInput): boolean {
  return input.format === 'concat';
}

export interface ConcatListLine {
  raw: string;
  file?: string;
}

export function parseConcatList(text: string): ConcatListLine[] {
  return text.split('\n').map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('file ')) return { raw };
    const file = unquoteConcatPath(trimmed.slice('file'.length).trim());
    return file ? { raw, file } : { raw };
  });
}

function unquoteConcatPath(rest: string): string {
  const quote = rest[0];

  if (quote !== "'" && quote !== '"') return rest.replace(/\\(.)/g, '$1');
  let out = '';
  for (let i = 1; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '\\' && quote === '"' && i + 1 < rest.length) {
      out += rest[i + 1];
      i += 1;
      continue;
    }
    if (ch !== quote) {
      out += ch;
      continue;
    }

    if (quote === "'" && rest.slice(i, i + 4) === "'\\''") {
      out += "'";
      i += 3;
      continue;
    }
    return out;
  }
  return out;
}

function concatMemberName(path: string, inputIdx: number, memberIdx: number): string {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/g, '_');
  return `__cat${inputIdx}_${memberIdx}_${base || 'part.bin'}`;
}

interface ConcatListError {
  kind: 'missing' | 'unsafe';
  file: string;
}

function isSafeConcatPath(file: string): boolean {
  if (file.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(file)) return false;
  return !file.split('/').includes('..');
}

function concatSafeMode(input: ParsedInput): boolean {
  const idx = input.raw.lastIndexOf('-safe');
  if (idx < 0) return true;
  const value = input.raw[idx + 1];
  return !(value === '0' || value?.startsWith('-'));
}

async function stageConcatList(
  listPath: string,
  listBytes: Uint8Array,
  inputIdx: number,
  safe: boolean,
  stage: StageNames,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1],
  note: (line: string) => void
): Promise<
  | { listBytes: Uint8Array; extraFiles: NonNullable<ResolvedInput['extraFiles']> }
  | { error: ConcatListError }
> {
  const lines = parseConcatList(new TextDecoder().decode(listBytes));
  const listDir = listPath.slice(0, listPath.lastIndexOf('/')) || '/';
  const extraFiles: NonNullable<ResolvedInput['extraFiles']> = [];
  const rewritten: string[] = [];

  for (const line of lines) {
    if (line.file === undefined) {
      rewritten.push(line.raw);
      continue;
    }

    if (safe && !isSafeConcatPath(line.file)) {
      return { error: { kind: 'unsafe', file: line.file } };
    }
    const resolved = ctx.fs.resolvePath(listDir, line.file);
    if (!(await ctx.fs.exists(resolved))) return { error: { kind: 'missing', file: line.file } };
    const ffmpegName = stagedPath(stage, concatMemberName(line.file, inputIdx, extraFiles.length));
    extraFiles.push({ ffmpegName, data: await readInputBlob(ctx.fs, resolved, note) });
    rewritten.push(`file '${ffmpegName}'`);
  }

  return { listBytes: new TextEncoder().encode(rewritten.join('\n')), extraFiles };
}

function isVirtualInput(input: ParsedInput): boolean {
  return input.format === 'lavfi';
}

async function loadResolvedInputs(
  parsed: ParsedFfmpegInvocation,
  stage: StageNames,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1],
  note: (line: string) => void = () => {}
): Promise<{ inputs: ResolvedInput[] } | { error: CmdResult }> {
  const resolvedInputs: ResolvedInput[] = [];
  for (const [idx, input] of parsed.inputs.entries()) {
    if (isVirtualInput(input)) {
      resolvedInputs.push({ ffmpegName: input.path, data: null, virtual: true });
      continue;
    }
    const resolved = ctx.fs.resolvePath(ctx.cwd, input.path);
    if (!(await ctx.fs.exists(resolved))) {
      return {
        error: {
          stdout: '',
          stderr: `ffmpeg: input file not found: ${input.path}\n`,
          exitCode: 1,
        },
      };
    }
    const ffmpegName = stagedPath(stage, inferInputName(input, idx));
    if (isConcatInput(input)) {
      const listBytes = await ctx.fs.readFileBuffer(resolved);
      const staged = await stageConcatList(
        resolved,
        listBytes,
        idx,
        concatSafeMode(input),
        stage,
        ctx,
        note
      );
      if ('error' in staged) {
        const { kind, file } = staged.error;
        const detail =
          kind === 'unsafe'
            ? `unsafe file name: ${file} (pass -safe 0 to allow it)`
            : `file not found: ${file}`;
        return {
          error: {
            stdout: '',
            stderr: `ffmpeg: concat list ${input.path}: ${detail}\n`,
            exitCode: 1,
          },
        };
      }
      resolvedInputs.push({
        ffmpegName,
        data: bytesToBlob(staged.listBytes),
        virtual: false,
        extraFiles: staged.extraFiles,
      });
      continue;
    }
    resolvedInputs.push({
      ffmpegName,
      data: await readInputBlob(ctx.fs, resolved, note),
      virtual: false,
    });
  }
  return { inputs: resolvedInputs };
}

export const MT_THREAD_BUDGET = { threads: 8, filterThreads: 2 } as const;

function hasThreadsFlag(tokens: readonly string[]): boolean {
  return tokens.some((t) => t === '-threads' || t.startsWith('-threads:'));
}

export function applyMtThreadBudget(
  parsed: ParsedFfmpegInvocation,
  budget: { threads: number; filterThreads: number } = MT_THREAD_BUDGET,
  cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined
): ParsedFfmpegInvocation {
  const threads = String(Math.max(1, Math.min(budget.threads, cores ?? budget.threads)));
  const all = [...parsed.inputs.flatMap((i) => i.raw), ...parsed.outputOpts];
  const globals: string[] = [];
  if (!all.includes('-filter_threads'))
    globals.push('-filter_threads', String(budget.filterThreads));
  if (!all.includes('-filter_complex_threads')) {
    globals.push('-filter_complex_threads', String(budget.filterThreads));
  }
  const inputs = parsed.inputs.map((input, idx) => {
    const prefix = [
      ...(idx === 0 ? globals : []),
      ...(hasThreadsFlag(input.raw) ? [] : ['-threads', threads]),
    ];
    return prefix.length > 0 ? { ...input, raw: [...prefix, ...input.raw] } : input;
  });
  const outputOpts = hasThreadsFlag(parsed.outputOpts)
    ? parsed.outputOpts
    : ['-threads', threads, ...parsed.outputOpts];
  return { ...parsed, inputs, outputOpts };
}

function mtMultiInputRefusal(stderr: string): CmdResult {
  return {
    stdout: '',
    stderr:
      `${stderr}ffmpeg: the multi-threaded core deadlocks with more than one input ` +
      '(ffmpeg starts a demux thread per input; emscripten proxies their pthread_create ' +
      'to a main thread blocked in exec; see #2810). Run without FFMPEG_CORE=mt so the ' +
      'single-threaded @ffmpeg/core handles this job.\n',
    exitCode: 1,
  };
}

function buildFinalFfmpegArgs(
  parsed: ParsedFfmpegInvocation,
  resolvedInputs: ResolvedInput[],
  outputName: string
): string[] {
  const finalArgs: string[] = [];
  for (const [idx, input] of parsed.inputs.entries()) {
    const resolved = resolvedInputs[idx];
    const raw = input.raw;
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] === '-i') {
        finalArgs.push('-i', resolved.virtual ? raw[k + 1] : resolved.ffmpegName);
        k += 1;
        continue;
      }
      finalArgs.push(raw[k]);
    }
  }
  finalArgs.push(...parsed.outputOpts);
  finalArgs.push(outputName);
  return finalArgs;
}

function stagedFiles(resolvedInputs: ResolvedInput[]): StagedFile[] {
  const files: StagedFile[] = [];
  for (const input of resolvedInputs) {
    if (input.data === null) continue;
    for (const extra of input.extraFiles ?? []) {
      files.push({ name: stagedBasename(extra.ffmpegName), data: extra.data });
    }
    files.push({ name: stagedBasename(input.ffmpegName), data: input.data });
  }
  return files;
}

async function ensureCoreHealthy(ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>): Promise<void> {
  const probe = '__health_probe';
  try {
    await ffmpeg.writeFile(probe, new Uint8Array([0]));
    await ffmpeg.deleteFile(probe);
  } catch (err) {
    if (isCoreFault(err)) throw err;
  }
}

async function cleanupMemfs(
  ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>,
  stage: StageNames,
  outputName: string
): Promise<void> {
  await unmountStagedInputs(ffmpeg, stage);
  await deleteStagedFile(ffmpeg, outputName);
}

async function readEncodedOutput(
  ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>,
  outputName: string,
  outputPath: string,
  readStderr: () => string
): Promise<{ bytes: Uint8Array } | { error: CmdResult }> {
  let outputData: Awaited<ReturnType<typeof ffmpeg.readFile>>;
  try {
    outputData = await ffmpeg.readFile(outputName);
  } catch (err) {
    if (isCoreFault(err)) throw err;
    return {
      error: {
        stdout: '',
        stderr: readStderr() || `ffmpeg: produced no output file for ${outputPath}\n`,
        exitCode: 1,
      },
    };
  }
  const bytes =
    outputData instanceof Uint8Array
      ? outputData
      : new TextEncoder().encode(typeof outputData === 'string' ? outputData : '');
  if (bytes.byteLength === 0) {
    return {
      error: {
        stdout: '',
        stderr: readStderr() || `ffmpeg: produced an empty output file for ${outputPath}\n`,
        exitCode: 1,
      },
    };
  }
  return { bytes };
}

function memfsOutputName(stage: StageNames, outputPath: string, analysisSink: boolean): string {
  if (analysisSink) return `__null_sink${stage.id}`;
  return stagedOutputName(stage, outputPath);
}

type FfmpegInstance = Awaited<ReturnType<typeof getFfmpeg>>;

function coreFaultResult(stderr: string, err: unknown): CmdResult {
  return {
    stdout: '',
    stderr:
      `${stderr}ffmpeg: ${err instanceof Error ? err.message : String(err)}\n` +
      'ffmpeg: the wasm core faulted and was recycled; retry the command ' +
      '(a large input may need to be split into smaller passes)\n',
    exitCode: 1,
  };
}

async function execWasmEncode(args: {
  ffmpeg: FfmpegInstance;
  parsed: ParsedFfmpegInvocation;
  resolvedInputs: ResolvedInput[];
  stage: StageNames;
  outputName: string;
  outputPath: string;
  analysisSink: boolean;

  readStderr: () => string;
}): Promise<{ early: CmdResult | null; outputBytes: Uint8Array | null }> {
  const {
    ffmpeg,
    parsed,
    resolvedInputs,
    stage,
    outputName,
    outputPath,
    analysisSink,
    readStderr,
  } = args;
  const mt = loadedFfmpegCorePackage() === FFMPEG_CORE_MT_PACKAGE;
  if (mt && parsed.inputs.length > 1) {
    return { early: mtMultiInputRefusal(readStderr()), outputBytes: null };
  }
  await mountStagedInputs(ffmpeg, stage, stagedFiles(resolvedInputs));

  const sinkParsed = analysisSink
    ? { ...parsed, outputOpts: ensureNullMuxerOpts(parsed.outputOpts) }
    : parsed;
  const execParsed = mt ? applyMtThreadBudget(sinkParsed) : sinkParsed;
  const finalArgs = buildFinalFfmpegArgs(execParsed, resolvedInputs, outputName);
  const exitCode = await ffmpeg.exec(finalArgs);
  if (exitCode !== 0) {
    return {
      early: {
        stdout: '',
        stderr: readStderr() || `ffmpeg: exited with code ${exitCode}\n`,
        exitCode: exitCode || 1,
      },
      outputBytes: null,
    };
  }
  if (analysisSink) {
    await ensureCoreHealthy(ffmpeg);
    return { early: { stdout: '', stderr: readStderr(), exitCode: 0 }, outputBytes: null };
  }
  const read = await readEncodedOutput(ffmpeg, outputName, outputPath, readStderr);
  if ('error' in read) return { early: read.error, outputBytes: null };
  return { early: null, outputBytes: read.bytes };
}

async function detachAndCleanupMemfs(args: {
  ffmpeg: FfmpegInstance;
  logHandler: (event: { type: string; message: string }) => void;
  stage: StageNames;
  outputName: string;
  readStderr: () => string;
  faulted: boolean;
}): Promise<CmdResult | null> {
  const { ffmpeg, logHandler, stage, outputName, readStderr, faulted } = args;
  try {
    ffmpeg.off('log', logHandler);
  } catch {}

  if (faulted) return null;
  try {
    await cleanupMemfs(ffmpeg, stage, outputName);
    return null;
  } catch (err) {
    if (!isCoreFault(err)) return null;
    recycleFfmpeg(ffmpeg);
    return coreFaultResult(readStderr(), err);
  }
}

async function tryMediabunnyFastPath(
  parsed: ParsedFfmpegInvocation,
  resolvedInputs: ResolvedInput[],
  outputPath: string,
  analysisSink: boolean,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1]
): Promise<Awaited<ReturnType<typeof import('./fast-path.js').runFfmpegFastPath>>> {
  const { ffmpegEngineFromEnv } = await import('./engine.js');
  const engine = ffmpegEngineFromEnv(ctx.env);
  const input = resolvedInputs.length === 1 ? resolvedInputs[0].data : null;
  if (engine === 'wasm' || analysisSink || input === null) {
    if (engine === 'mediabunny') {
      return {
        result: {
          stdout: '',
          stderr:
            'ffmpeg: FFMPEG_ENGINE=mediabunny cannot run this: analysis sinks, lavfi and concat inputs are wasm-only\n',
          exitCode: 1,
        },
      };
    }
    return { fallback: true, note: null };
  }
  const { runFfmpegFastPath } = await import('./fast-path.js');
  return runFfmpegFastPath({
    parsed,
    input,
    outputPath: ctx.fs.resolvePath(ctx.cwd, outputPath),
    fs: ctx.fs,
    engine,
  });
}

async function runWasmFfmpeg(
  parsed: ParsedFfmpegInvocation,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1]
): Promise<CmdResult> {
  const stage = newStage();
  const notes: string[] = [];
  const loaded = await loadResolvedInputs(parsed, stage, ctx, (line) => notes.push(line));
  if ('error' in loaded) return loaded.error;
  const resolvedInputs = loaded.inputs;

  const outputPath = parsed.outputPath!;
  const analysisSink = isAnalysisSink(parsed);

  const fast = await tryMediabunnyFastPath(parsed, resolvedInputs, outputPath, analysisSink, ctx);
  if ('result' in fast) return fast.result;
  const result = await runOnWasmCore({
    parsed,
    ctx,
    stage,
    resolvedInputs,
    outputPath,
    analysisSink,
  });

  const prefix = [...(fast.note ? [`ffmpeg: ${fast.note}`] : []), ...notes]
    .map((l) => `${l}\n`)
    .join('');
  return prefix ? { ...result, stderr: `${prefix}${result.stderr}` } : result;
}

async function runOnWasmCore(args: {
  parsed: ParsedFfmpegInvocation;
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1];
  stage: StageNames;
  resolvedInputs: ResolvedInput[];
  outputPath: string;
  analysisSink: boolean;
}): Promise<CmdResult> {
  const { parsed, ctx, stage, resolvedInputs, outputPath, analysisSink } = args;
  const outputName = memfsOutputName(stage, outputPath, analysisSink);

  let stderr = '';
  let ffmpeg: FfmpegInstance;
  try {
    ffmpeg = await getFfmpeg({
      onProgress: (msg) => {
        stderr += `${msg}\n`;
      },
      ipk: createIpkContextFromCtx(ctx),
      preferMt: ffmpegCoreFromEnv(ctx.env) === 'mt',
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
  let faulted = false;
  let early: CmdResult | null = null;
  let outputBytes: Uint8Array | null = null;
  try {
    const encoded = await execWasmEncode({
      ffmpeg,
      parsed,
      resolvedInputs,
      stage,
      outputName,
      outputPath,
      analysisSink,
      readStderr: () => stderr,
    });
    early = encoded.early;
    outputBytes = encoded.outputBytes;
  } catch (err) {
    faulted = true;
    recycleFfmpeg(ffmpeg);
    early = coreFaultResult(stderr, err);
  } finally {
    const cleanupFault = await detachAndCleanupMemfs({
      ffmpeg,
      logHandler,
      stage,
      outputName,
      readStderr: () => stderr,
      faulted,
    });
    if (cleanupFault) early = cleanupFault;
  }
  if (early) return early;

  try {
    await ctx.fs.writeFile(
      ctx.fs.resolvePath(ctx.cwd, outputPath),
      outputBytes ?? new Uint8Array()
    );
  } catch (err) {
    return {
      stdout: '',
      stderr: `${stderr}ffmpeg: cannot write ${outputPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  return { stdout: '', stderr, exitCode: 0 };
}
