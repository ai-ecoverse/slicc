/**
 * `ffmpeg` shell command body. Registered through the stub in
 * `../ffmpeg-command.ts`, which `import()`s this module on FIRST USE so
 * the argv grammar, camera capture, WORKERFS staging and both engines
 * stay out of the kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`).
 *
 * Two engines sit behind the CLI: the mediabunny fast path
 * (`./fast-path.ts`) and the `@ffmpeg/core` wasm (`../ffmpeg-wasm.ts`,
 * ipk-installed by the user).
 *
 * Two notable paths:
 *
 *  1. **Plain ffmpeg invocation**: argv-style flags + at least one
 *     `-i INPUT` and a trailing output filename. Inputs are read
 *     from the VFS into the FFmpeg in-memory FS, the binary is
 *     invoked with the user's args, and the output file is read
 *     back into the VFS. Log lines from `ffmpeg.on('log')` are
 *     forwarded to stderr so timing and progress are visible.
 *     **Analysis sinks** (`-f null` with `-` or `/dev/null`, or a
 *     bare `/dev/null`) skip VFS writeback — the product is the
 *     filter log on stderr (`silencedetect`, `loudnorm`, …).
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

/** The ctx `defineCommand` hands its callback (limits resolved), as the stub passes it. */
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

/**
 * `ffmpeg -version` is gated behind an ipk-installed `@ffmpeg/core`
 * for parity with `tsc` / `esbuild` / `biome` — there is no bundled
 * binary, so reporting a version without the core present would lie.
 * Resolves the core through the shared loader (no wasm boot) and
 * surfaces the canonical `ipk add @ffmpeg/core` guidance when absent.
 */
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
  /**
   * Inputs in order. Each input's `raw` carries the options that
   * precede it on the command line (so the wasm reconstruction can
   * splice them back into argv unchanged).
   */
  inputs: ParsedInput[];
  /** Options that precede the final output positional. */
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

// Conservative list of ffmpeg flags that consume a single value.
// Anything not in the list is treated as a boolean toggle.
//
// A missing entry does not degrade gracefully: the flag's value is
// read as a positional, which makes it a phantom output path AND
// flushes every option pending at that point into that phantom
// output — so those options silently vanish from argv. `-safe 0`
// swallowed the `-f concat` bound to the very next `-i`, leaving the
// core to probe a text file as media ("Invalid data found when
// processing input").
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
  // Bitstream filters. Their absence was not cosmetic: `-c copy
  // -bsf:v h264_mp4toannexb -f mpegts out.ts` silently lost BOTH the
  // filter and `-c copy`, so a stream copy became a full re-encode.
  '-bsf',
  '-bsf:v',
  '-bsf:a',
  // Encoder/muxer options common in remux and concat recipes.
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

/**
 * Options that really are pure toggles. Everything else that starts
 * with `-` and is not in {@link VALUE_TAKING_FLAGS} is treated as
 * value-taking by {@link handleGenericOptionToken}, because in ffmpeg
 * the value-taking options vastly outnumber the toggles — so guessing
 * "toggle" for an unknown flag is the wrong default.
 */
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

/**
 * Push the parsed `-i FILE` onto `state.inputs`, capturing the
 * pending pre-input options (`-f`, `-video_size`, …) so per-input
 * flags stay bound to the right file when argv is rebuilt.
 */
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

/**
 * Is there another positional at or after `from`?
 *
 * The trailing positional is the output path, so this is how a
 * candidate option value is told apart from the output itself. Known
 * value-taking flags are skipped along with their values so their
 * arguments are not mistaken for positionals.
 */
function hasLaterPositional(args: string[], from: number): boolean {
  for (let i = from; i < args.length; i++) {
    const tok = args[i];
    // A lone `-` is ffmpeg's stdin/stdout filename, so it is a
    // positional despite starting with `-`. Missing that let an
    // unknown option before a null sink lose its value:
    // `-unknown_opt val -f null -` saw no later positional, treated
    // `-unknown_opt` as a toggle, and dropped both tokens from argv.
    if (!tok.startsWith('-') || tok === '-') return true;
    if (VALUE_TAKING_FLAGS.has(tok)) i += 1;
  }
  return false;
}

/**
 * Decide whether an option we do not recognize consumes the next
 * token as its value.
 *
 * Guessing "toggle" is the wrong default. ffmpeg's value-taking
 * options vastly outnumber its toggles, and a wrong guess does not
 * degrade gracefully: the value falls through to
 * {@link handlePositionalToken}, which makes it a phantom output path
 * AND moves every option pending at that moment into that phantom
 * output's options — so they never reach the real output or input.
 * That is how `-c copy -bsf:v h264_mp4toannexb` lost both tokens and
 * turned a stream copy into a re-encode.
 *
 * So an unknown flag consumes the next token unless one of the
 * following says otherwise:
 *  - there is no next token;
 *  - the next token is itself an option (`-…`);
 *  - the next token is the only positional left, making it the output
 *    path. Testing for a later *positional* rather than for the last
 *    argv entry is what keeps an unknown toggle from swallowing the
 *    output when options trail it, as in
 *    `ffmpeg -i in.mp4 -bitexact out.mp4 -y`.
 */
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
  // Positional: binds to an output file. Whatever options were
  // pending at this point apply to *this* output. We currently
  // surface only the last output, but options for it are correct.
  state.outputPath = tok;
  state.outputOpts = state.pendingOpts;
  state.pendingOpts = [];
  return i + 1;
}

export function parseFfmpegArgs(args: string[]): ParsedFfmpegInvocation {
  // ffmpeg's option binding rule: most options apply to the *next*
  // file (input or output) they precede on the command line. We
  // collect each option into `pendingOpts` and flush it the next
  // time we hit a `-i FILE` (binds to that input) or a positional
  // path (binds to that output). This preserves correctness for
  // multi-input invocations like `-i a.mp4 -ss 5 -i b.mp4 out.mp4`
  // where `-ss 5` is a seek on `b.mp4`, not an output option.
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
    // avfoundation device enumeration request. ffmpeg writes the
    // device list to stderr and exits non-zero with "Output file is
    // required" if you actually try to run, so we intercept up front.
    if (tok === '-list_devices') {
      i = handleListDevicesToken(state, args, i);
      continue;
    }
    // Custom flag: photo warmup override (ms).
    if (tok === '-warmup') {
      i = handleWarmupToken(state, args, i);
      continue;
    }
    // Custom flag: switch getUserMedia constraints to `exact:`.
    if (tok === '-exact_size') {
      state.exactSize = true;
      i += 1;
      continue;
    }
    // Lone `-` is ffmpeg's stdin/stdout filename. Accept it as an
    // output positional ONLY when `-f null` is already pending —
    // analysis sinks (`… -f null -`). Without the null muxer we do
    // not emulate stdout; treating `-` as a generic positional would
    // silently write a VFS file named `-` (e.g. `ffmpeg -i in -f mp3 -`).
    // Falling through to the flag branch leaves outputPath unset so
    // the command reports "at least one output file must be specified".
    // `-i -` is unaffected: `-i` consumes the next token via
    // VALUE_TAKING_FLAGS before this branch runs.
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

/**
 * True when the invocation should be served by the browser's
 * webcam pipeline instead of the WASM ffmpeg binary. Centralized
 * so tests can assert on the predicate independent of execution.
 */
export function isAvfoundationCapture(parsed: ParsedFfmpegInvocation): boolean {
  return parsed.inputs.some((input) => input.format === 'avfoundation');
}

/** Output tokens that discard media rather than naming a VFS artifact. */
const ANALYSIS_SINK_TOKENS = new Set(['-', '/dev/null']);

/** True when `outputOpts` contain an explicit `-f null` (null muxer). */
function hasNullMuxer(outputOpts: string[]): boolean {
  for (let i = 0; i < outputOpts.length - 1; i++) {
    if (outputOpts[i] === '-f' && outputOpts[i + 1] === 'null') return true;
  }
  return false;
}

/**
 * An analysis sink discards encoded media; the caller's product is
 * what filters print on stderr (`silencedetect`, `loudnorm`, …).
 *
 * Detection (deliberately narrow so a failed encode cannot report
 * success):
 * - Output token is `-` or `/dev/null`, AND
 * - either `-f null` is in the output options, OR the token is
 *   `/dev/null` itself (MEMFS has no `/dev/null` device — treating a
 *   bare `/dev/null` as a sink avoids a guaranteed empty-artifact
 *   failure; {@link ensureNullMuxerOpts} injects `-f null` before exec).
 *
 * A bare `-` without `-f null` is NOT a sink and is not accepted as an
 * output positional at all (stdout is not emulated) — see the `-`
 * branch in {@link parseFfmpegArgs}.
 */
export function isAnalysisSink(parsed: ParsedFfmpegInvocation): boolean {
  const out = parsed.outputPath;
  if (out === null || !ANALYSIS_SINK_TOKENS.has(out)) return false;
  if (out === '/dev/null') return true;
  return hasNullMuxer(parsed.outputOpts);
}

/**
 * Ensure output opts carry `-f null` for an analysis sink. Bare
 * `/dev/null` is recognized as a sink without the flag on the
 * command line; without injecting the muxer the pinned core exits 1
 * with "Unable to find a suitable output format for '__null_sink'".
 */
export function ensureNullMuxerOpts(outputOpts: string[]): string[] {
  if (hasNullMuxer(outputOpts)) return outputOpts;
  return [...outputOpts, '-f', 'null'];
}

/**
 * Build an {@link IpkResolutionContext} from a command's `ctx` so
 * `getFfmpeg` can locate the ipk-installed `@ffmpeg/core` in the
 * VFS `node_modules`. Mirrors `createIpkContextFromCtx` in
 * `tsc-command.ts` / `esbuild-command.ts` / `biome-command.ts` so
 * every float wires the loader the same way.
 */
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

/**
 * Map a parsed camera capture plan onto the `<slicc-permissions>`
 * kinds the leader surface should prompt for: `'camera'` whenever a
 * video track is requested, `'microphone'` for video-mode captures
 * that include audio. Audio-only captures fall under `'microphone'`
 * alone — the request flags `captureVideo: false` so no camera
 * prompt is needed. Exported for unit tests.
 */
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

/** Stop any live MediaStream tracks carried by media-kind permission grants. */
function stopProbeStreamTracks(grants: ReadonlyArray<unknown>): void {
  for (const grant of grants) {
    const stream = (grant as { stream?: MediaStream }).stream;
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
}

/**
 * Page-realm permission gate: when the leader `<slicc-permissions>` surface
 * is mounted in this tab, run its prompt directly. Returns the gate result,
 * or `null` when no surface is reachable (caller falls through to the
 * panel-RPC bridge / legacy capture path). The prompt opens live camera/mic
 * MediaStreams to prime the grant, but this path only GATES the real capture
 * (ffmpeg opens its own stream downstream), so the probe tracks are stopped
 * to avoid leaving a duplicate camera/mic stream active after the command.
 */
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
    // Surface prompt threw — fall through to the panel-RPC bridge /
    // legacy capture path rather than failing the command outright.
    return null;
  }
}

/**
 * Route a camera/mic capture request through the unified leader
 * `<slicc-permissions>` surface BEFORE handing off to the underlying
 * capture mechanism (panel-rpc, direct `getUserMedia`, or the
 * extension capture popup). Mirrors the composer-speech mic flow
 * (`packages/webapp/src/speech/composer-speech.ts`) and the
 * `permission-request` panel-RPC handler:
 *
 * - Page realm with a mounted surface → call `surface.prompt(...)`
 *   directly (`skipIfGranted: true` so a persisted camera/mic origin
 *   grant skips the in-app Allow/Cancel overlay). Granted → `{ ok: true }`;
 *   cancelled / error → clean denial message.
 * - Worker realm → round-trip via `panel-rpc('permission-request')`
 *   with the same `skipIfGranted` flag; the page-side handler forwards
 *   to the same surface.
 * - No surface mounted (boot race, test environment without a
 *   leader, …) → fall through with `{ ok: true }` so the legacy
 *   capture path can still surface the browser's native prompt
 *   instead of failing the command outright.
 *
 * Exported for unit-test composition.
 */
export async function requestCapturePermission(
  kinds: PermissionRpcKind[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (kinds.length === 0) return { ok: true };
  const description = `ffmpeg is requesting access to your ${describeKindsForPrompt(kinds)}.`;

  // Page realm: ask the in-tab surface directly when one is mounted.
  const pageResult = await tryPageRealmCapturePermission(kinds, description);
  if (pageResult) return pageResult;

  // Worker realm: bridge to the leader surface via panel-RPC. The
  // generous 5-minute timeout matches the underlying capture call —
  // the user may take a while to click Allow in the prompt UI.
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
      // No mounted surface (boot race, headless test) — fall through
      // and let the legacy capture path surface the browser's own
      // prompt; preserves backward compatibility for callers that
      // never set up the leader UI.
      if (/permission surface unavailable/i.test(message)) {
        return { ok: true };
      }
      return { ok: false, message };
    }
  }

  // No realm to route through — proceed and let the capture path
  // surface its own error.
  return { ok: true };
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
  // `-update 1` is ffmpeg's image-sequence "overwrite same file"
  // toggle; treat anything else (including `-update 0` or a missing
  // flag) as off. The previous shortcut also reached index -1 + 1
  // and matched on `outputOpts[0] === '1'`, which mis-classified
  // some invocations.
  const updateIdx = parsed.outputOpts.indexOf('-update');
  const updateMode = updateIdx >= 0 && parsed.outputOpts[updateIdx + 1] === '1';
  const tIdx = parsed.outputOpts.indexOf('-t');
  const durationSeconds = tIdx >= 0 ? parseFloat(parsed.outputOpts[tIdx + 1]) : NaN;

  const spec = parseAvfoundationDeviceSpec(input.path);
  const inferredMime = inferOutputMime(parsed.outputPath);
  const isPhotoOutput = /^image\//.test(inferredMime);
  // Audio-only requests collapse to video-mode at the capture layer
  // (MediaRecorder records audio tracks into a webm container) but
  // `captureVideo: false` is forwarded so getUserMedia doesn't ask
  // for a camera that isn't needed (avoids the camera-permission
  // prompt + fails gracefully on devices with no webcam).
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

/** The `ffmpeg` command body; `ffmpeg-command.ts` binds it lazily. */
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

type CmdResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Run the popup-based extension capture path and normalize the
 * payload into a {@link CameraCaptureResult}. The bytes are copied
 * through a fresh `ArrayBuffer` so the VFS write later in the
 * pipeline gets a non-shared backing buffer.
 */
async function captureViaExtensionPopup(
  plan: ReturnType<typeof buildCameraRequest>
): Promise<CameraCaptureResult> {
  // Extension mode: capture in a visible popup window so Chrome can
  // show its camera/mic permission prompt — the offscreen document
  // (where this shell command usually runs) has no surface for it.
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

/**
 * Round-trip the capture request through the panel-RPC bridge to
 * the page realm. Returns `null` when no bridge is available so
 * the caller can surface the standard "requires a browser context"
 * error.
 */
async function captureViaPanelRpc(
  plan: ReturnType<typeof buildCameraRequest>
): Promise<CameraCaptureResult | null> {
  const panelRpc = getPanelRpcClient();
  if (!panelRpc) return null;
  // Camera capture can take a while when permission has not
  // been granted yet (user has to click "Allow") — give it a
  // generous timeout matching `screencapture`.
  const r = await panelRpc.call('capture-camera', plan.request, { timeoutMs: 5 * 60_000 });
  return {
    bytes: r.bytes,
    mimeType: r.mimeType,
    width: r.width,
    height: r.height,
    durationMs: r.durationMs,
  };
}

/**
 * Pick a capture mechanism (extension popup → direct getUserMedia
 * → panel-RPC) and return either the captured frames/clip or a
 * fully-formed shell error result. The error mapper translates
 * NotAllowed / NotFound into friendly messages.
 */
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

  // Route every capture mechanism (popup, direct getUserMedia,
  // panel-RPC) through the unified leader `<slicc-permissions>`
  // surface first. The surface gates the prompt UI; on grant, the
  // browser-level camera/mic permission carries through to the
  // capture call below (same origin, same activation).
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
 * satisfy on its own. The capture is mounted (WORKERFS) under a name
 * matching the capture mime so ffmpeg picks the right demuxer; the
 * output path is reduced to a filename for MEMFS. `ipk` is the
 * VFS resolution context the loader uses to find the user-installed
 * `@ffmpeg/core` package — without it (or with `@ffmpeg/core`
 * missing), the loader throws the canonical `ipk add` guidance
 * error which the caller surfaces verbatim.
 */
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
    // Shares the realm-cached core with `runWasmFfmpeg`, so a trap
    // here poisons `ffmpeg` for the whole session too. The non-zero
    // exit above is our own throw and leaves the core healthy, so
    // only genuine faults retire the instance.
    if (isCoreFault(err)) {
      faulted = true;
      recycleFfmpeg(ffmpeg);
    }
    throw err;
  } finally {
    try {
      ffmpeg.off('log', logHandler);
    } catch {
      /* noop */
    }
    if (!faulted) {
      try {
        await unmountStagedInputs(ffmpeg, stage);
        await deleteStagedFile(ffmpeg, outputName);
      } catch {
        /* noop */
      }
    }
  }
}

interface ResolvedInput {
  /** Path inside the core's FS the rewritten `-i` points at (or the lavfi spec). */
  ffmpegName: string;
  /** `null` for virtual (lavfi) inputs that have no backing VFS file. */
  data: Blob | null;
  /** True for libavfilter virtual sources (`-f lavfi -i testsrc=...`). */
  virtual: boolean;
  /**
   * Files named *inside* a concat list, staged alongside it. The
   * demuxer opens these itself rather than receiving them through
   * argv, so they must be mounted under exactly the names the
   * rewritten list points at.
   */
  extraFiles?: Array<{ ffmpegName: string; data: Blob }>;
}

/** True for a concat-demuxer input (`-f concat -i list.txt`). */
function isConcatInput(input: ParsedInput): boolean {
  return input.format === 'concat';
}

/**
 * One line of a concat-demuxer list. `file` is set only for a
 * `file <path>` directive — the one kind that names an external
 * input. Every other line (`duration`, `inpoint`, `outpoint`,
 * `ffconcat version 1.0`, comments, blanks) is carried through
 * untouched, so options the user set still reach the demuxer.
 *
 * Exported so the quoting rules are testable without the wasm core.
 */
export interface ConcatListLine {
  raw: string;
  file?: string;
}

/**
 * Parse a concat-demuxer list file. ffmpeg accepts a path bare, in
 * single quotes, or in double quotes; a literal `'` inside a
 * single-quoted path is written `'\''`.
 */
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
  // Bare form: ffmpeg still honours backslash escapes, so
  // `file clip\ one.mp4` names `clip one.mp4`. Returning the token
  // verbatim would look for a member with a literal backslash and
  // report a perfectly good list as missing a file.
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
    // `'\''` re-opens the quote to embed one literal apostrophe.
    if (quote === "'" && rest.slice(i, i + 4) === "'\\''") {
      out += "'";
      i += 3;
      continue;
    }
    return out;
  }
  return out;
}

/**
 * MEMFS is flat, so a staged concat member needs a name that is
 * unique across the whole invocation and free of characters that
 * would need quoting inside the rewritten list.
 */
function concatMemberName(path: string, inputIdx: number, memberIdx: number): string {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/g, '_');
  return `__cat${inputIdx}_${memberIdx}_${base || 'part.bin'}`;
}

/** Why a concat member could not be staged. */
interface ConcatListError {
  kind: 'missing' | 'unsafe';
  file: string;
}

/**
 * ffmpeg's concat demuxer refuses absolute paths and parent traversal
 * unless `-safe 0` is passed. Mirror that rather than silently
 * granting `-safe 0` semantics to every list: a script that works here
 * should work against a real ffmpeg, and vice versa.
 */
function isSafeConcatPath(file: string): boolean {
  if (file.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(file)) return false;
  return !file.split('/').includes('..');
}

/**
 * Effective value of the demuxer's `safe` option for this input.
 * ffmpeg defaults it to enabled, so only an explicit `-safe 0`
 * (or a negative value) turns the check off.
 */
function concatSafeMode(input: ParsedInput): boolean {
  const idx = input.raw.lastIndexOf('-safe');
  if (idx < 0) return true;
  const value = input.raw[idx + 1];
  return !(value === '0' || value?.startsWith('-'));
}

/**
 * Resolve every file a concat list names, and rewrite the list to point
 * at the staged names they will be mounted under.
 *
 * Without this, `-f concat` cannot work at all: only paths that
 * appear as `-i` reach the staging pass, so the demuxer opened
 * members that were never staged. Member paths resolve against the
 * *list file's* directory, matching ffmpeg, rather than the shell cwd.
 */
async function stageConcatList(
  listPath: string,
  listBytes: Uint8Array,
  inputIdx: number,
  safe: boolean,
  stage: StageNames,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1]
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
    // Rewriting every member to a flat `__cat…` name would make the
    // demuxer's own safety check trivially pass, so the check has to
    // happen here, on the path the user actually wrote.
    if (safe && !isSafeConcatPath(line.file)) {
      return { error: { kind: 'unsafe', file: line.file } };
    }
    const resolved = ctx.fs.resolvePath(listDir, line.file);
    if (!(await ctx.fs.exists(resolved))) return { error: { kind: 'missing', file: line.file } };
    const ffmpegName = stagedPath(stage, concatMemberName(line.file, inputIdx, extraFiles.length));
    extraFiles.push({ ffmpegName, data: await readInputBlob(ctx.fs, resolved) });
    rewritten.push(`file '${ffmpegName}'`);
  }

  return { listBytes: new TextEncoder().encode(rewritten.join('\n')), extraFiles };
}

/**
 * True when an input is a libavfilter virtual source (`-f lavfi`).
 * These are synthesized by ffmpeg itself (`testsrc`, `color`,
 * `sine`, …) and have no file on the VFS, so path resolution,
 * MEMFS staging, and argv `-i` rewriting must all be skipped — the
 * filter spec is passed straight through to the wasm core.
 */
function isVirtualInput(input: ParsedInput): boolean {
  return input.format === 'lavfi';
}

/**
 * Resolve every `-i FILE` against the VFS up front and open it as a
 * lazily-read `Blob`. Returns a fully-typed list of staged-name + blob
 * pairs, or a `{ error }` shell result on the first missing input.
 * Virtual (`lavfi`) inputs carry no data and pass through unchanged.
 */
async function loadResolvedInputs(
  parsed: ParsedFfmpegInvocation,
  stage: StageNames,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1]
): Promise<{ inputs: ResolvedInput[] } | { error: CmdResult }> {
  const resolvedInputs: ResolvedInput[] = [];
  for (const [idx, input] of parsed.inputs.entries()) {
    if (isVirtualInput(input)) {
      // lavfi sources are generated by ffmpeg — keep the filter spec
      // (carried in the input's `-i` raw token) and read no file.
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
      // The list itself is small and has to be rewritten, so it is the
      // one input still read whole.
      const listBytes = await ctx.fs.readFileBuffer(resolved);
      const staged = await stageConcatList(
        resolved,
        listBytes,
        idx,
        concatSafeMode(input),
        stage,
        ctx
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
      data: await readInputBlob(ctx.fs, resolved),
      virtual: false,
    });
  }
  return { inputs: resolvedInputs };
}

/**
 * Thread budget for the multi-threaded core. Its emscripten pthread pool
 * holds 32 workers; a thread requested beyond the pool needs the main
 * thread's event loop to load a new worker, and that thread is blocked in
 * `exec` — a deadlock, not an error. ffmpeg's defaults (encoder threads =
 * 1.5 × cores, one filter thread per core PER GRAPH) blow past 32 on any
 * modern machine, so unless the caller set them, encoders and decoders get
 * {@link MT_THREAD_BUDGET.threads} and every filter graph
 * {@link MT_THREAD_BUDGET.filterThreads}. Verified live: x264 at 8 threads
 * on a single input completes; default filter threads hang.
 */
export const MT_THREAD_BUDGET = { threads: 8, filterThreads: 2 } as const;

function hasThreadsFlag(tokens: readonly string[]): boolean {
  return tokens.some((t) => t === '-threads' || t.startsWith('-threads:'));
}

/**
 * Inject the mt thread budget into a parsed invocation, leaving any
 * caller-supplied `-threads` / `-filter_threads` alone. `-threads` is a
 * per-stream option in ffmpeg (before an `-i` it binds to that input's
 * decoders, before the output to its encoders), so it is added in every
 * position; the filter-thread options are global and go first. Exported
 * for unit tests.
 */
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

/** Why a multi-input job is refused on the mt core instead of hanging. */
function mtMultiInputRefusal(stderr: string): CmdResult {
  return {
    stdout: '',
    stderr:
      `${stderr}ffmpeg: the multi-threaded core deadlocks with more than one input ` +
      '(ffmpeg starts a demux thread per input; emscripten proxies their pthread_create ' +
      'to a main thread blocked in exec). Run without FFMPEG_CORE=mt so the single-threaded ' +
      '@ffmpeg/core handles this job.\n',
    exitCode: 1,
  };
}

/**
 * Rebuild argv with the MEMFS-local input names. Each input's
 * `raw` carries the options that precede it on the user's command
 * line, so splicing them back keeps per-input flags (`-ss`, `-f`,
 * `-vf`, …) bound to the right file.
 */
function buildFinalFfmpegArgs(
  parsed: ParsedFfmpegInvocation,
  resolvedInputs: ResolvedInput[],
  outputName: string
): string[] {
  const finalArgs: string[] = [];
  for (const [idx, input] of parsed.inputs.entries()) {
    // Strip the original -i path and replace with the MEMFS name.
    // Preserve any pre-input options the user provided (`-f`,
    // `-video_size`, …) so user filters survive.
    const resolved = resolvedInputs[idx];
    const raw = input.raw;
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] === '-i') {
        // Virtual (lavfi) inputs keep their original filter spec —
        // there is no MEMFS file to point `-i` at.
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

/**
 * Every file one invocation mounts, as WORKERFS entries. Virtual (lavfi)
 * inputs are synthesized by ffmpeg itself, so they carry no data and are
 * skipped. Concat members ride in the same mount as the list that names
 * them, so the demuxer finds them the moment it reads the list.
 */
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

/**
 * Cheap post-exec touch of the shared core. Analysis sinks skip
 * {@link readEncodedOutput} (the only other place that rethrows
 * {@link isCoreFault}), so without a probe a stale exit-0 after an
 * internal `Aborted()` would report success and leave the poisoned
 * instance cached for every later command — defeating the recycle
 * invariant. A disposable write+delete traps the same way readback
 * would; ordinary FS noise is ignored.
 */
async function ensureCoreHealthy(ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>): Promise<void> {
  const probe = '__health_probe';
  try {
    await ffmpeg.writeFile(probe, new Uint8Array([0]));
    await ffmpeg.deleteFile(probe);
  } catch (err) {
    if (isCoreFault(err)) throw err;
  }
}

/**
 * Best-effort cleanup so repeated invocations don't pile up stale
 * mounts and megabytes of encoded output in the wasm heap. Ordinary
 * misses are swallowed; a core fault is rethrown so the caller can
 * recycle instead of caching a dead instance.
 */
async function cleanupMemfs(
  ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>,
  stage: StageNames,
  outputName: string
): Promise<void> {
  await unmountStagedInputs(ffmpeg, stage);
  await deleteStagedFile(ffmpeg, outputName);
}

/**
 * Read the encoded artifact back out of MEMFS.
 *
 * `@ffmpeg/core` can report exit 0 even when the encode aborted
 * internally — a WASM `Aborted()` leaves the return code stale — so
 * the artifact is trusted over the code, and a missing or empty file
 * is a failure.
 *
 * A *trap* during readback is different in kind: the core died
 * mid-encode. Reporting that as "produced no output" would leave the
 * poisoned instance cached and let cleanup re-enter the dead module —
 * exactly the session-wide failure this is meant to prevent — so it
 * is rethrown for the caller's recycling handler.
 */
async function readEncodedOutput(
  ffmpeg: Awaited<ReturnType<typeof getFfmpeg>>,
  outputName: string,
  outputPath: string,
  stderr: string
): Promise<{ bytes: Uint8Array } | { error: CmdResult }> {
  let outputData: Awaited<ReturnType<typeof ffmpeg.readFile>>;
  try {
    outputData = await ffmpeg.readFile(outputName);
  } catch (err) {
    if (isCoreFault(err)) throw err;
    return {
      error: {
        stdout: '',
        stderr: stderr || `ffmpeg: produced no output file for ${outputPath}\n`,
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
        stderr: stderr || `ffmpeg: produced an empty output file for ${outputPath}\n`,
        exitCode: 1,
      },
    };
  }
  return { bytes };
}

/**
 * MEMFS name for the encode artifact. Analysis sinks never produce a
 * readable file — stage a disposable placeholder the null muxer can
 * point at, then skip readback.
 */
function memfsOutputName(stage: StageNames, outputPath: string, analysisSink: boolean): string {
  if (analysisSink) return `__null_sink${stage.id}`;
  return stagedOutputName(stage, outputPath);
}

type FfmpegInstance = Awaited<ReturnType<typeof getFfmpeg>>;

/** Shared recycle message when the realm-cached core has to be retired. */
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

/**
 * Run exec + sink health probe or encode readback. Throws on core
 * traps so the caller can recycle.
 */
async function execWasmEncode(args: {
  ffmpeg: FfmpegInstance;
  parsed: ParsedFfmpegInvocation;
  resolvedInputs: ResolvedInput[];
  stage: StageNames;
  outputName: string;
  outputPath: string;
  analysisSink: boolean;
  stderr: string;
}): Promise<{ early: CmdResult | null; outputBytes: Uint8Array | null }> {
  const { ffmpeg, parsed, resolvedInputs, stage, outputName, outputPath, analysisSink, stderr } =
    args;
  const mt = loadedFfmpegCorePackage() === FFMPEG_CORE_MT_PACKAGE;
  if (mt && parsed.inputs.length > 1) {
    return { early: mtMultiInputRefusal(stderr), outputBytes: null };
  }
  await mountStagedInputs(ffmpeg, stage, stagedFiles(resolvedInputs));

  // Bare `/dev/null` is a sink without `-f null` on the CLI; inject
  // the muxer so the pinned core does not exit 1 looking for a
  // container format for `__null_sink`.
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
        stderr: stderr || `ffmpeg: exited with code ${exitCode}\n`,
        exitCode: exitCode || 1,
      },
      outputBytes: null,
    };
  }
  if (analysisSink) {
    // Product is the filter log on stderr (silencedetect / loudnorm / …).
    // Skip MEMFS readback and the VFS write below — including not
    // writing a literal `/dev/null` path. Probe first: sinks never
    // call readEncodedOutput, so this is the health gate that keeps
    // a stale exit-0 after Aborted() from poisoning later commands.
    await ensureCoreHealthy(ffmpeg);
    return { early: { stdout: '', stderr, exitCode: 0 }, outputBytes: null };
  }
  const read = await readEncodedOutput(ffmpeg, outputName, outputPath, stderr);
  if ('error' in read) return { early: read.error, outputBytes: null };
  return { early: null, outputBytes: read.bytes };
}

/**
 * Detach the log handler and tidy MEMFS. If cleanup is the first place
 * a stale-zero poison surfaces, recycle and return a fault result.
 */
async function detachAndCleanupMemfs(args: {
  ffmpeg: FfmpegInstance;
  logHandler: (event: { type: string; message: string }) => void;
  stage: StageNames;
  outputName: string;
  stderr: string;
  faulted: boolean;
}): Promise<CmdResult | null> {
  const { ffmpeg, logHandler, stage, outputName, stderr, faulted } = args;
  try {
    ffmpeg.off('log', logHandler);
  } catch {
    /* noop */
  }
  // A terminated worker has no MEMFS left to tidy, and every
  // `deleteFile` would re-enter the trapped module.
  if (faulted) return null;
  try {
    await cleanupMemfs(ffmpeg, stage, outputName);
    return null;
  } catch (err) {
    if (!isCoreFault(err)) return null;
    recycleFfmpeg(ffmpeg);
    return coreFaultResult(stderr, err);
  }
}

/**
 * mediabunny (WebCodecs) first, for the argv shapes it expresses exactly:
 * one real input, one output in a container it writes, options that all
 * map (`ffmpeg/bunny-translate.ts`). Analysis sinks, lavfi, concat and
 * filtergraphs go straight to the wasm core. `FFMPEG_ENGINE=wasm` skips
 * this entirely; `FFMPEG_ENGINE=mediabunny` fails instead of falling back.
 * The module is `import()`ed so mediabunny never rides the boot graph.
 */
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
  // Validate inputs up front so we don't pay the cold-start cost
  // before realizing the user typo'd a path.
  const stage = newStage();
  const loaded = await loadResolvedInputs(parsed, stage, ctx);
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
  // Say why the fast path stepped aside, ahead of the core's own log — but
  // only once the run is over, so the "core printed nothing" defaults inside
  // still see an empty log.
  return fast.note ? { ...result, stderr: `ffmpeg: ${fast.note}\n${result.stderr}` } : result;
}

/** The wasm core leg: boot (or reuse) the shared instance, stage, exec, read back. */
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
      stderr,
    });
    early = encoded.early;
    outputBytes = encoded.outputBytes;
  } catch (err) {
    // A *throw* out of the wasm path is not an ordinary ffmpeg
    // failure — bad flags and unsupported codecs come back as a
    // non-zero exit code, handled above. What lands here is the core
    // itself faulting, which leaves the realm-shared instance
    // unusable for every later command. Retire that generation so the
    // damage is scoped to this invocation.
    faulted = true;
    recycleFfmpeg(ffmpeg);
    early = coreFaultResult(stderr, err);
  } finally {
    const cleanupFault = await detachAndCleanupMemfs({
      ffmpeg,
      logHandler,
      stage,
      outputName,
      stderr,
      faulted,
    });
    if (cleanupFault) early = cleanupFault;
  }
  if (early) return early;

  // Deliberately OUTSIDE the wasm try/catch. A read-only mount or an
  // exhausted quota makes this throw while the core is perfectly
  // healthy; blaming that on the core would cost a needless ~31 MB
  // reboot and tell the user the wrong thing.
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
