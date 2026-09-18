import type { ComputerFrame } from '@slicc/shared-ts';
import type { CommandContext } from 'just-bash';
import { scratchDir } from '../../tmpdir-env.js';
import { FFMPEG_ENGINE_ENV } from '../ffmpeg/engine.js';

export const COMPUTER_RECORD_DEFAULT_FPS = 2;

export const COMPUTER_RECORD_MAX_WIDTH = 768;

export const COMPUTER_RECORD_MAX_FPS = 10;
export const COMPUTER_RECORD_MAX_FRAMES = 60 * COMPUTER_RECORD_MAX_FPS;

export const COMPUTER_RECORD_MAX_BYTES = 8 * 1024 * 1024;

export interface RecordedClip {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
  truncated?: boolean;
}

export interface CollectPolledFramesOpts {
  screenshot: () => Promise<ComputerFrame>;
  durationMs: number;
  fps: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;

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
      const raw: unknown = await anyFs.readFile(path, { encoding: 'binary' });
      if (raw instanceof Uint8Array) existing = Uint8Array.from(raw);
    } catch {}
  }
  const next = new Uint8Array(existing.byteLength + chunk.byteLength);
  next.set(existing, 0);
  next.set(chunk, existing.byteLength);
  await fs.writeFile(path, next);
}

export async function collectPolledFrames(opts: CollectPolledFramesOpts): Promise<{
  width: number;
  height: number;
  frameCount: number;
  byteLength: number;
  durationMs: number;
  truncated: boolean;
}> {
  const fps = clampRecordFps(opts.fps);
  const interval = Math.max(1, Math.round(1000 / fps));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const end = now() + opts.durationMs;
  let width = 0;
  let height = 0;
  let frameCount = 0;
  let byteLength = 0;
  let truncated = false;
  for (;;) {
    const frame = await opts.screenshot();
    const nextBytes = byteLength + frame.bytes.byteLength;
    if (
      frameCount > 0 &&
      (frameCount >= COMPUTER_RECORD_MAX_FRAMES || nextBytes > COMPUTER_RECORD_MAX_BYTES)
    ) {
      truncated = true;
      break;
    }
    width = frame.width;
    height = frame.height;
    await opts.onFrame?.(frame.bytes);
    frameCount += 1;
    byteLength = nextBytes;
    const hitCap =
      frameCount >= COMPUTER_RECORD_MAX_FRAMES || byteLength >= COMPUTER_RECORD_MAX_BYTES;
    const hitTime = now() + interval >= end;
    if (hitCap || hitTime) {
      truncated = hitCap && Math.round((frameCount / fps) * 1000) < opts.durationMs;
      break;
    }
    await sleep(interval);
  }
  return {
    width,
    height,
    frameCount,
    byteLength,
    durationMs: truncated ? Math.round((frameCount / fps) * 1000) : opts.durationMs,
    truncated,
  };
}

function uniqueMjpegPath(ctx: CommandContext): string {
  const dir = scratchDir(ctx.env).replace(/\/$/u, '');
  const id = crypto.randomUUID();
  return ctx.fs.resolvePath(ctx.cwd, `${dir}/computer-record-${id}.mjpeg`);
}

async function removeScratch(fs: CommandContext['fs'], path: string): Promise<void> {
  const anyFs = fs as { rm?: (p: string, o?: { force?: boolean }) => Promise<void> };
  if (typeof anyFs.rm === 'function') {
    await anyFs.rm(path, { force: true }).catch(() => undefined);
  }
}

function wasmEngineEnv(env: CommandContext['env']): Map<string, string> {
  const next = env instanceof Map ? new Map(env) : new Map<string, string>();
  next.set(FFMPEG_ENGINE_ENV, 'wasm');
  return next;
}

export async function encodeFramesWithFfmpeg(args: EncodeRecordedFramesArgs): Promise<{
  mime: string;
}> {
  const { runFfmpeg } = await import('../ffmpeg/run.js');
  const createdScratch = !args.sourcePath;
  const tempPath = args.sourcePath ?? uniqueMjpegPath(args.ctx);
  if (createdScratch) {
    await args.ctx.fs.mkdir(tempPath.slice(0, tempPath.lastIndexOf('/')), { recursive: true });
    await args.ctx.fs.writeFile(tempPath, concatFrameBytes(args.frames));
  }
  try {
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
  } finally {
    if (createdScratch) await removeScratch(args.ctx.fs, tempPath);
  }
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
  const sourcePath = uniqueMjpegPath(opts.ctx);
  await opts.ctx.fs.mkdir(sourcePath.slice(0, sourcePath.lastIndexOf('/')), { recursive: true });
  await opts.ctx.fs.writeFile(sourcePath, new Uint8Array(0));
  try {
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
      durationMs: collected.durationMs,
      ctx: opts.ctx,
    });
    let bytes = new Uint8Array(0);
    try {
      bytes = await readClipBytes(opts.ctx, opts.dest);
    } catch {}
    return {
      bytes,
      mime,
      width: collected.width,
      height: collected.height,
      durationMs: collected.durationMs,
      ...(collected.truncated ? { truncated: true } : {}),
    };
  } finally {
    await removeScratch(opts.ctx.fs, sourcePath);
  }
}
