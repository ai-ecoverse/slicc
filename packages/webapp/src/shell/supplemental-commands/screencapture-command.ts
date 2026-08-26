import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import { captureViaPopup, isExtensionFloat } from './extension-media-capture.js';
import { basename } from './shared.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

const SCREENCAPTURE_BOOL_FLAGS = ['--clipboard', '-c', '--view', '-v'] as const;

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

async function captureScreenBytes(
  local: boolean,
  panelRpc: NonNullable<ReturnType<typeof getPanelRpcClient>>,
  mimeType: string,
  quality: number
): Promise<{ bytes: Uint8Array } | { error: ScreencaptureResult }> {
  try {
    if (isExtensionFloat()) {
      const popup = await captureViaPopup({ kind: 'screen', mimeType, quality });
      return { bytes: popup.bytes };
    }
    if (local) {
      const r = await captureLocally(mimeType, quality);
      return { bytes: r.bytes };
    }
    const r = await panelRpc.call(
      'screencapture',
      { mimeType, quality },
      { timeoutMs: 5 * 60_000 }
    );
    return { bytes: new Uint8Array(r.bytes) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Permission denied') || message.includes('NotAllowedError')) {
      return { error: scFail('user cancelled or permission denied') };
    }
    return { error: scFail(message) };
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
  if (view) {
    const base64 = toBase64(bytes);
    return {
      stdout: `${fullPath} (${sizeKB} KB)\n<img:data:${mimeType};base64,${base64}>`,
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
  -h, --help       Show this help message
  -c, --clipboard  Copy to clipboard instead of saving to file
  -v, --view       Return image inline so the agent can see it

The browser will prompt you to select a screen, window, or tab to capture.
Output format is determined by file extension (.png, .jpg, .jpeg, .webp).

Examples:
  screencapture screenshot.png       # Capture to file
  screencapture -c                   # Capture to clipboard
  screencapture -v capture.png       # Capture and return for agent vision
`,
    stderr: '',
    exitCode: 0,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function getMimeTypeForExtension(filename: string): string {
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

/**
 * Capture pixels via the DOM directly. Only callable from a context
 * that has `navigator.mediaDevices` and `document` (panel terminal,
 * extension offscreen). The kernel worker reaches the same code path
 * by going through the panel-RPC bridge instead.
 */
async function captureLocally(
  mimeType: string,
  quality: number
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () =>
        video
          .play()
          .then(() => resolve())
          .catch(reject);
      video.onerror = () => reject(new Error('Failed to load video stream'));
    });
    await new Promise<void>((r) => setTimeout(r, 100));

    const width = video.videoWidth;
    const height = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to create image blob'))),
        mimeType,
        quality
      );
    });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
  } finally {
    stream.getTracks().forEach((t) => {
      t.stop();
    });
  }
}

export function createScreencaptureCommand(): Command {
  return defineCommand('screencapture', async (args, ctx) => {
    if (isHelpRequest(args)) {
      return screencaptureHelp();
    }

    const parsed = parseKnownFlags(args, { bool: SCREENCAPTURE_BOOL_FLAGS });
    if ('error' in parsed) {
      return scFail(parsed.error);
    }

    const local = hasLocalDom();
    const panelRpc = getPanelRpcClient();
    const envError = checkScreencaptureEnv(local, panelRpc);
    if (envError) return envError;

    const toClipboard = parsed.bools.has('--clipboard') || parsed.bools.has('-c');
    const view = parsed.bools.has('--view') || parsed.bools.has('-v');
    const outputFile = parsed.positionals[0];

    if (!toClipboard && !outputFile) {
      return scFail('output file required (or use -c for clipboard)');
    }

    const filename = outputFile || 'screenshot.png';
    const mimeType = getMimeTypeForExtension(filename);
    const quality = mimeType === 'image/png' ? 1.0 : 0.92;

    const captured = await captureScreenBytes(local, panelRpc!, mimeType, quality);
    if ('error' in captured) return captured.error;

    if (toClipboard) {
      return writeClipboardOutput(captured.bytes, mimeType, local, panelRpc!);
    }

    return writeFileOutput(captured.bytes, filename, mimeType, view, ctx);
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
