/**
 * `computer record` for worker-hosted kinds: poll JPEG screenshots and
 * pipe them through in-repo ffmpeg wasm (`-f image2pipe`). The `screen`
 * kind keeps its MediaRecorder path and never comes through here.
 */

import type { ComputerFrame } from '@slicc/shared-ts';
import type { CommandContext } from 'just-bash';
import { scratchDir } from '../../tmpdir-env.js';
import { FFMPEG_ENGINE_ENV } from '../ffmpeg/engine.js';

export const COMPUTER_RECORD_DEFAULT_FPS = 2;
/** Cap polled stills so a 60s clip stays inside the wasm heap. */
export const COMPUTER_RECORD_MAX_WIDTH = 768;
/** `--fps` ceiling: 60s at 10 fps is 600 stills. */
export const COMPUTER_RECORD_MAX_FPS = 10;
export const COMPUTER_RECORD_MAX_FRAMES = 60 * COMPUTER_RECORD_MAX_FPS;
/** Aggregate JPEG bytes streamed into the encoder (one still in memory). */
export const COMPUTER_RECORD_MAX_BYTES = 8 * 1024 * 1024;

export interface RecordedClip {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
}

export interface CollectPolledFramesOpts {
  screenshot: () => Promise<ComputerFrame>;
  durationMs: number;
  fps: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with each JPEG then dropped — do not retain the array. */
  onFrame?: (bytes: Uint8Array) => void | Promise<void>;
}

export interface EncodeRecordedFramesArgs {
  frames: Uint8Array[];
  fps: number;
  dest: string;
  width: number;
  height: number;
  durationMs: number;
  ctx: CommandContext;
  /** MJPEG already streamed to disk; preferred over concatenating `frames`. */
  sourcePath?: string;
}

export function concatFrameBytes(frames: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const frame of frames) total += frame.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.byteLength;
  }
  return out;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function clampRecordFps(fps: number): number {
  return Math.min(COMPUTER_RECORD_MAX_FPS, Math.max(1, fps));
}

type AppendableFs = CommandContext['fs'] & {
  appendFile?: (path: string, data: Uint8Array) => Promise<void>;
  readFile?: (path: string, opts?: { encoding?: string }) => Promise<unknown>;
};

async function appendBytes(
  fs: CommandContext['fs'],
  path: string,
  chunk: Uint8Array
): Promise<void> {
  const anyFs = fs as AppendableFs;
  if (typeof anyFs.appendFile === 'function') {
    await anyFs.appendFile(path, chunk);
    return;
  }
  let existing = new Uint8Array(0);
  if (typeof anyFs.readFile === 'function') {
    try {
      const raw = await anyFs.readFile(path, { encoding: 'binary' });
      if (raw instanceof Uint8Array) existing = raw;
    } catch {
      /* first frame */
    }
  }
  const next = new Uint8Array(existing.byteLength + chunk.byteLength);
  next.set(existing, 0);
  next.set(chunk, existing.byteLength);
  await fs.writeFile(path, next);
}

/** Grab JPEG stills at `fps` until `durationMs` elapses. Always ≥1 frame. */
export async function collectPolledFrames(
  opts: CollectPolledFramesOpts
): Promise<{ width: number; height: number; frameCount: number; byteLength: number }> {
  const fps = clampRecordFps(opts.fps);
  const interval = Math.max(1, Math.round(1000 / fps));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const end = now() + opts.durationMs;
  let width = 0;
  let height = 0;
  let frameCount = 0;
  let byteLength = 0;
  for (;;) {
    const frame = await opts.screenshot();
    width = frame.width;
    height = frame.height;
    await opts.onFrame?.(frame.bytes);
    frameCount += 1;
    byteLength += frame.bytes.byteLength;
    if (
      frameCount >= COMPUTER_RECORD_MAX_FRAMES ||
      byteLength >= COMPUTER_RECORD_MAX_BYTES ||
      now() + interval >= end
    ) {
      break;
    }
    await sleep(interval);
  }
  return { width, height, frameCount, byteLength };
}

function wasmEngineEnv(env: CommandContext['env']): Map<string, string> {
  const next = env instanceof Map ? new Map(env) : new Map<string, string>();
  next.set(FFMPEG_ENGINE_ENV, 'wasm');
  return next;
}

/** Stream JPEGs through `ffmpeg -f image2pipe` into `dest`. */
export async function encodeFramesWithFfmpeg(args: EncodeRecordedFramesArgs): Promise<{
  mime: string;
}> {
  const { runFfmpeg } = await import('../ffmpeg/run.js');
  const tmp = `${scratchDir(args.ctx.env).replace(/\/$/u, '')}/computer-record-frames.mjpeg`;
  const tempPath = args.sourcePath ?? args.ctx.fs.resolvePath(args.ctx.cwd, tmp);
  if (!args.sourcePath) {
    await args.ctx.fs.mkdir(tempPath.slice(0, tempPath.lastIndexOf('/')), { recursive: true });
    await args.ctx.fs.writeFile(tempPath, concatFrameBytes(args.frames));
  }
  const result = await runFfmpeg(
    [
      '-y',
      '-hide_banner',
      '-nostdin',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-framerate',
      String(args.fps),
      '-i',
      tempPath,
      '-an',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libvpx',
      '-b:v',
      '1M',
      '-pix_fmt',
      'yuv420p',
      args.dest,
    ],
    { ...args.ctx, env: wasmEngineEnv(args.ctx.env) } as Parameters<typeof runFfmpeg>[1]
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || 'ffmpeg failed';
    throw new Error(detail);
  }
  return { mime: 'video/webm' };
}

async function readClipBytes(ctx: CommandContext, dest: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = (await ctx.fs.readFile(dest, { encoding: 'binary' })) as unknown;
  if (!(raw instanceof Uint8Array)) return new Uint8Array();
  return Uint8Array.from(raw);
}

export async function recordPolledClip(opts: {
  screenshot: () => Promise<ComputerFrame>;
  durationMs: number;
  fps: number;
  dest: string;
  ctx: CommandContext;
  encode?: (args: EncodeRecordedFramesArgs) => Promise<{ mime: string }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RecordedClip> {
  const fps = clampRecordFps(opts.fps);
  const tmp = `${scratchDir(opts.ctx.env).replace(/\/$/u, '')}/computer-record-frames.mjpeg`;
  const sourcePath = opts.ctx.fs.resolvePath(opts.ctx.cwd, tmp);
  await opts.ctx.fs.mkdir(sourcePath.slice(0, sourcePath.lastIndexOf('/')), { recursive: true });
  const collected = await collectPolledFrames({
    screenshot: opts.screenshot,
    durationMs: opts.durationMs,
    fps,
    now: opts.now,
    sleep: opts.sleep,
    onFrame: (bytes) => appendBytes(opts.ctx.fs, sourcePath, bytes),
  });
  const encode = opts.encode ?? encodeFramesWithFfmpeg;
  const { mime } = await encode({
    frames: [],
    sourcePath,
    fps,
    dest: opts.dest,
    width: collected.width,
    height: collected.height,
    durationMs: opts.durationMs,
    ctx: opts.ctx,
  });
  let bytes = new Uint8Array(0);
  try {
    bytes = await readClipBytes(opts.ctx, opts.dest);
  } catch {
    /* encoder may have written dest on a fs that tests do not read back */
  }
  return {
    bytes,
    mime,
    width: collected.width,
    height: collected.height,
    durationMs: opts.durationMs,
  };
}
