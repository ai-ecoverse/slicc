import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { basename } from './shared.js';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';

function screencaptureHelp(): { stdout: string; stderr: string; exitCode: number } {
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
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

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
    stream.getTracks().forEach((t) => t.stop());
  }
}

export function createScreencaptureCommand(): Command {
  return defineCommand('screencapture', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return screencaptureHelp();
    }

    const local = hasLocalDom();
    const panelRpc = getPanelRpcClient();
    if (!local && !panelRpc) {
      return {
        stdout: '',
        stderr: 'screencapture: browser APIs are unavailable in this environment\n',
        exitCode: 1,
      };
    }
    if (local && !navigator.mediaDevices?.getDisplayMedia) {
      return {
        stdout: '',
        stderr: 'screencapture: screen capture is not supported in this browser\n',
        exitCode: 1,
      };
    }

    const toClipboard = args.includes('--clipboard') || args.includes('-c');
    const view = args.includes('--view') || args.includes('-v');
    const knownFlags = ['--clipboard', '-c', '--view', '-v', '--help', '-h'];
    const dashDashIndex = args.indexOf('--');
    const filteredArgs =
      dashDashIndex >= 0
        ? args.slice(dashDashIndex + 1)
        : args.filter((a) => !knownFlags.includes(a));
    const outputFile = filteredArgs[0];

    if (!toClipboard && !outputFile) {
      return {
        stdout: '',
        stderr: 'screencapture: output file required (or use -c for clipboard)\n',
        exitCode: 1,
      };
    }

    const filename = outputFile || 'screenshot.png';
    const mimeType = getMimeTypeForExtension(filename);
    const quality = mimeType === 'image/png' ? 1.0 : 0.92;

    let bytes: Uint8Array;
    try {
      if (local) {
        const r = await captureLocally(mimeType, quality);
        bytes = r.bytes;
      } else {
        // Worker context: round-trip via the page. The bridge timeout
        // is generous because the user has to pick a target in the
        // OS-level capture picker, which may take many seconds.
        const r = await panelRpc!.call(
          'screencapture',
          { mimeType, quality },
          { timeoutMs: 5 * 60_000 }
        );
        bytes = new Uint8Array(r.bytes);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Permission denied') || message.includes('NotAllowedError')) {
        return {
          stdout: '',
          stderr: 'screencapture: user cancelled or permission denied\n',
          exitCode: 1,
        };
      }
      return {
        stdout: '',
        stderr: `screencapture: ${message}\n`,
        exitCode: 1,
      };
    }

    if (toClipboard) {
      try {
        if (local) {
          // Stay on the page: convert to PNG if needed and write to
          // navigator.clipboard directly. Wait for the document to
          // regain focus first — after a full-screen / window capture
          // through the OS-level `getDisplayMedia` picker the SLICC
          // tab is no longer focused, and `clipboard.write` rejects
          // with "Document is not focused".
          const pngBytes = await ensurePngBytes(bytes, mimeType);
          const pngBuffer = new ArrayBuffer(pngBytes.byteLength);
          new Uint8Array(pngBuffer).set(pngBytes);
          const pngBlob = new Blob([pngBuffer], { type: 'image/png' });
          await whenDocumentFocused();
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
          const sizeKB = Math.round(pngBlob.size / 1024);
          return { stdout: `captured ${sizeKB} KB to clipboard\n`, stderr: '', exitCode: 0 };
        }
        // Worker: bridge the clipboard write too — navigator.clipboard
        // doesn't exist on WorkerNavigator. The page-side handler does
        // its own focus wait, so we just need a generous bridge timeout
        // in case the user takes a while to refocus the tab.
        await panelRpc!.call(
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
        return {
          stdout: '',
          stderr: `screencapture: failed to copy to clipboard: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    }

    // Save to file
    const fullPath = ctx.fs.resolvePath(ctx.cwd, filename);
    try {
      await ctx.fs.writeFile(fullPath, bytes);
    } catch (err) {
      return {
        stdout: '',
        stderr: `screencapture: failed to write file: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
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
