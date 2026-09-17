import { uint8ToBase64 } from '@slicc/shared-ts';
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import { captureViaPopup, isExtensionFloat } from './extension-media-capture.js';
import {
  captureDisplayMedia,
  clampVideoDurationMs,
  type DisplayCaptureRequest,
  describeDisplayCaptureError,
} from './screencapture-media.js';
import { basename } from './shared.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

const SCREENCAPTURE_BOOL_FLAGS = [
  '--clipboard',
  '-c',
  '--view',
  '-v',
  '--video',
  '--audio',
  '-g',
] as const;

const SCREENCAPTURE_VALUE_FLAGS = ['-V', '--duration'] as const;

/** Expand macOS-style attached shorts (`-V10`) into `-V` + `10`. */
function expandAttachedDurationFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    const m = /^-V(\d+(?:\.\d+)?)$/.exec(arg);
    if (m) {
      out.push('-V', m[1]!);
      continue;
    }
    out.push(arg);
  }
  return out;
}

type ScreencaptureResult = { stdout: string; stderr: string; exitCode: number };

function scFail(message: string): ScreencaptureResult {
  return { stdout: '', stderr: `screencapture: ${message}\n`, exitCode: 1 };
}

function checkScreencaptureEnv(
  local: boolean,
  panelRpc: ReturnType<typeof getPanelRpcClient>
): ScreencaptureResult | null {
  if (!local && !panelRpc) {
    return scFail('browser APIs are unavailable in this environment');
  }
  if (local && !isExtensionFloat() && !navigator.mediaDevices?.getDisplayMedia) {
    return scFail('screen capture is not supported in this browser');
  }
  return null;
}

function isVideoExtension(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext === 'webm' || ext === 'mp4' || ext === 'mkv';
}

function getImageMimeTypeForExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'png':
    default:
      return 'image/png';
  }
}

function getVideoMimeTypeForExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  // Browsers almost always emit WebM from MediaRecorder; prefer an honest
  // container. Callers that pass .mp4 still get video/webm bytes (see help).
  if (ext === 'mp4' && typeof MediaRecorder !== 'undefined') {
    if (MediaRecorder.isTypeSupported('video/mp4')) return 'video/mp4';
  }
  return 'video/webm';
}

async function captureScreenBytes(
  local: boolean,
  panelRpc: NonNullable<ReturnType<typeof getPanelRpcClient>>,
  request: DisplayCaptureRequest
): Promise<
  { bytes: Uint8Array; mimeType: string; durationMs?: number } | { error: ScreencaptureResult }
> {
  try {
    if (isExtensionFloat()) {
      const popup = await captureViaPopup({
        kind: 'screen',
        mimeType: request.mimeType,
        quality: request.mode === 'image' ? request.quality : 1,
        mode: request.mode,
        ...(request.mode === 'video'
          ? {
              durationMs: request.durationMs,
              audio: !!request.audio,
            }
          : {}),
      });
      return {
        bytes: popup.bytes,
        mimeType: popup.mimeType,
        ...(popup.durationMs !== undefined ? { durationMs: popup.durationMs } : {}),
      };
    }
    if (local) {
      const r = await captureDisplayMedia(request);
      return {
        bytes: r.bytes,
        mimeType: r.mimeType,
        ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      };
    }
    const r = await panelRpc.call(
      'screencapture',
      {
        mimeType: request.mimeType,
        quality: request.mode === 'image' ? request.quality : 1,
        mode: request.mode,
        ...(request.mode === 'video'
          ? {
              durationMs: request.durationMs,
              audio: !!request.audio,
            }
          : {}),
      },
      {
        // Video can run up to 60s plus picker time.
        timeoutMs: request.mode === 'video' ? 5 * 60_000 + request.durationMs : 5 * 60_000,
      }
    );
    return {
      bytes: new Uint8Array(r.bytes),
      mimeType: r.mimeType,
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    };
  } catch (err) {
    return { error: scFail(describeDisplayCaptureError(err)) };
  }
}

async function writeClipboardOutput(
  bytes: Uint8Array,
  mimeType: string,
  local: boolean,
  panelRpc: NonNullable<ReturnType<typeof getPanelRpcClient>>
): Promise<ScreencaptureResult> {
  try {
    if (
      isExtensionFloat() &&
      typeof document !== 'undefined' &&
      typeof document.hasFocus === 'function' &&
      !document.hasFocus()
    ) {
      return scFail('clipboard capture needs a focused window; save to a file instead');
    }
    if (local) {
      const pngBytes = await ensurePngBytes(bytes, mimeType);
      const pngBuffer = new ArrayBuffer(pngBytes.byteLength);
      new Uint8Array(pngBuffer).set(pngBytes);
      const pngBlob = new Blob([pngBuffer], { type: 'image/png' });
      await whenDocumentFocused();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      const sizeKB = Math.round(pngBlob.size / 1024);
      return { stdout: `captured ${sizeKB} KB to clipboard\n`, stderr: '', exitCode: 0 };
    }
    await panelRpc.call(
      'clipboard-write-image',
      {
        bytes: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer,
        mimeType,
      },
      { timeoutMs: 5 * 60_000 }
    );
    const sizeKB = Math.round(bytes.byteLength / 1024);
    return { stdout: `captured ${sizeKB} KB to clipboard\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return scFail(`failed to copy to clipboard: ${message}`);
  }
}

async function writeFileOutput(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  view: boolean,
  video: boolean,
  durationMs: number | undefined,
  ctx: Parameters<Command['execute']>[1]
): Promise<ScreencaptureResult> {
  const fullPath = ctx.fs.resolvePath(ctx.cwd, filename);
  try {
    await ctx.fs.writeFile(fullPath, bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return scFail(`failed to write file: ${message}`);
  }

  const sizeKB = Math.round(bytes.length / 1024);
  if (view && !video) {
    const base64 = uint8ToBase64(bytes);
    return {
      stdout: `${fullPath} (${sizeKB} KB)\n<img:data:${mimeType};base64,${base64}>`,
      stderr: '',
      exitCode: 0,
    };
  }
  if (video) {
    const secs = durationMs !== undefined ? ` (${Math.round(durationMs / 100) / 10}s)` : '';
    return {
      stdout: `captured ${sizeKB} KB${secs} video to ${basename(fullPath)}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return {
    stdout: `captured ${sizeKB} KB to ${basename(fullPath)}\n`,
    stderr: '',
    exitCode: 0,
  };
}

function screencaptureHelp(): ScreencaptureResult {
  return {
    stdout: `screencapture - capture screen, window, or tab using browser screen sharing

Usage: screencapture [options] <output-file>

Options:
  -h, --help           Show this help message
  -c, --clipboard      Copy a still image to the clipboard (not video)
  -v, --view           Return a still image inline so the agent can see it
  --video              Record a video clip (also implied by .webm/.mp4/.mkv)
  -V, --duration <s>   Limit video length in seconds (default 5, max 60)
  -g, --audio          Include system/tab audio when recording video

Still output format follows the file extension (.png, .jpg, .jpeg, .webp).
Video is recorded via MediaRecorder as WebM (use a .webm extension).

The browser will prompt you to select a screen, window, or tab to capture.
Stop sharing in the browser chrome to end a video early.

Examples:
  screencapture screenshot.png       # Capture still to file
  screencapture -c                   # Capture still to clipboard
  screencapture -v capture.png       # Capture still for agent vision
  screencapture --video -V 10 clip.webm   # 10s screen recording
  screencapture -V5 clip.webm        # .webm implies video; 5s limit
`,
    stderr: '',
    exitCode: 0,
  };
}

interface ScreencaptureOptions {
  toClipboard: boolean;
  view: boolean;
  audio: boolean;
  wantVideo: boolean;
  filename: string;
  durationMs?: number;
}

/**
 * `parseKnownFlags` refuses to swallow a known boolean as a value flag's
 * argument (`-V --audio` keeps `--audio` as a bool). That leaves `-V` present
 * in argv with no entry in `values`, which would otherwise silently fall back
 * to the default duration. Detect that case and fail closed.
 */
function durationFlagMissingValue(
  expanded: readonly string[],
  values: Map<string, string>
): boolean {
  if (values.has('-V') || values.has('--duration')) return false;
  return expanded.some((a) => a === '-V' || a === '--duration');
}

function parseScreencaptureOptions(
  args: readonly string[]
): ScreencaptureOptions | ScreencaptureResult {
  const expanded = expandAttachedDurationFlags(args);
  const parsed = parseKnownFlags(expanded, {
    bool: SCREENCAPTURE_BOOL_FLAGS,
    value: SCREENCAPTURE_VALUE_FLAGS,
  });
  if ('error' in parsed) return scFail(parsed.error);
  if (durationFlagMissingValue(expanded, parsed.values)) {
    return scFail('-V/--duration requires a value');
  }

  const toClipboard = parsed.bools.has('--clipboard') || parsed.bools.has('-c');
  const view = parsed.bools.has('--view') || parsed.bools.has('-v');
  const audio = parsed.bools.has('--audio') || parsed.bools.has('-g');
  const outputFile = parsed.positionals[0];
  const durationRaw = parsed.values.get('-V') ?? parsed.values.get('--duration');

  if (!toClipboard && !outputFile) {
    return scFail('output file required (or use -c for clipboard)');
  }

  const filename = outputFile || 'screenshot.png';
  const wantVideo =
    parsed.bools.has('--video') || durationRaw !== undefined || isVideoExtension(filename);

  const modeError = validateCaptureMode({ wantVideo, toClipboard, view, audio, filename });
  if (modeError) return modeError;

  const duration = resolveVideoDurationMs(wantVideo, durationRaw);
  if ('error' in duration) return duration.error;

  return {
    toClipboard,
    view,
    audio,
    wantVideo,
    filename,
    ...(duration.durationMs !== undefined ? { durationMs: duration.durationMs } : {}),
  };
}

function validateCaptureMode(opts: {
  wantVideo: boolean;
  toClipboard: boolean;
  view: boolean;
  audio: boolean;
  filename: string;
}): ScreencaptureResult | null {
  if (opts.wantVideo && opts.toClipboard) {
    return scFail('video capture cannot go to the clipboard; save to a .webm file');
  }
  if (opts.wantVideo && opts.view) {
    return scFail('video capture cannot use --view; save to a file and open it');
  }
  if (opts.audio && !opts.wantVideo) {
    return scFail('-g/--audio requires video mode (--video or a .webm/.mp4 file)');
  }
  if (opts.wantVideo && !/\.(webm|mp4|mkv)$/i.test(opts.filename)) {
    return scFail('video capture requires a .webm (preferred), .mp4, or .mkv output file');
  }
  return null;
}

function resolveVideoDurationMs(
  wantVideo: boolean,
  durationRaw: string | undefined
): { durationMs?: number } | { error: ScreencaptureResult } {
  if (durationRaw !== undefined) {
    const secs = Number(durationRaw);
    if (!Number.isFinite(secs) || secs <= 0) {
      return {
        error: scFail(`-V/--duration requires a positive number of seconds (got ${durationRaw})`),
      };
    }
    return { durationMs: clampVideoDurationMs(secs * 1000) };
  }
  if (wantVideo) return { durationMs: clampVideoDurationMs(undefined) };
  return {};
}

function buildCaptureRequest(opts: ScreencaptureOptions): DisplayCaptureRequest {
  if (opts.wantVideo) {
    return {
      mode: 'video',
      mimeType: getVideoMimeTypeForExtension(opts.filename),
      durationMs: opts.durationMs ?? clampVideoDurationMs(undefined),
      audio: opts.audio,
    };
  }
  const mimeType = getImageMimeTypeForExtension(opts.filename);
  return {
    mode: 'image',
    mimeType,
    quality: mimeType === 'image/png' ? 1.0 : 0.92,
  };
}

export function createScreencaptureCommand(): Command {
  return defineCommand('screencapture', async (args, ctx) => {
    if (isHelpRequest(args, { valueFlags: [...SCREENCAPTURE_VALUE_FLAGS] })) {
      return screencaptureHelp();
    }

    const opts = parseScreencaptureOptions(args);
    if ('exitCode' in opts) return opts;

    const local = hasLocalDom();
    const panelRpc = getPanelRpcClient();
    const envError = checkScreencaptureEnv(local, panelRpc);
    if (envError) return envError;

    const captured = await captureScreenBytes(local, panelRpc!, buildCaptureRequest(opts));
    if ('error' in captured) return captured.error;

    if (opts.toClipboard) {
      return writeClipboardOutput(captured.bytes, captured.mimeType, local, panelRpc!);
    }

    return writeFileOutput(
      captured.bytes,
      opts.filename,
      captured.mimeType,
      opts.view,
      opts.wantVideo,
      captured.durationMs,
      ctx
    );
  });
}

/**
 * Convert raw image bytes to PNG bytes when the source isn't already
 * PNG. Only used on the local DOM path — the bridge path defers PNG
 * conversion to the page-side `clipboard-write-image` handler.
 */
async function ensurePngBytes(bytes: Uint8Array, mimeType: string): Promise<Uint8Array> {
  if (mimeType === 'image/png') return bytes;
  const safeBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(safeBuffer).set(bytes);
  const blob = new Blob([safeBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image for conversion'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    ctx.drawImage(img, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to create PNG blob'))),
        'image/png'
      );
    });
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Resolve once `document.hasFocus()` is true so a follow-up
 * `navigator.clipboard.write` call doesn't reject with "Document is
 * not focused". Mirrors the helper used on the panel-RPC handler side;
 * kept local to keep this file callable from worker-importable code
 * paths without dragging UI deps along (the function is only ever
 * called on the local-DOM branch).
 */
async function whenDocumentFocused(timeoutMs = 5 * 60_000): Promise<void> {
  if (typeof document === 'undefined') return;
  // Treat a missing `hasFocus` (lightweight test stubs) as already
  // focused so we don't wedge tests that don't bother mocking it.
  if (typeof document.hasFocus !== 'function') return;
  if (document.hasFocus()) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
    };
    const onFocus = () => {
      if (document.hasFocus()) {
        cleanup();
        resolve();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for window focus'));
    }, timeoutMs);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
  });
}
