import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { basename } from './shared.js';

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

async function captureScreen(mimeType: string, quality: number): Promise<Blob> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      displaySurface: 'monitor',
    },
    audio: false,
  });

  try {
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const width = settings.width ?? 1920;
    const height = settings.height ?? 1080;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.play().then(() => resolve()).catch(reject);
      };
      video.onerror = () => reject(new Error('Failed to load video stream'));
    });

    // Wait a frame to ensure video is rendered
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    ctx.drawImage(video, 0, 0, width, height);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to create image blob'));
          }
        },
        mimeType,
        quality,
      );
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function createScreencaptureCommand(): Command {
  return defineCommand('screencapture', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return screencaptureHelp();
    }

    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return {
        stdout: '',
        stderr: 'screencapture: browser APIs are unavailable in this environment\n',
        exitCode: 1,
      };
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      return {
        stdout: '',
        stderr: 'screencapture: screen capture is not supported in this browser\n',
        exitCode: 1,
      };
    }

    const toClipboard = args.includes('--clipboard') || args.includes('-c');
    const view = args.includes('--view') || args.includes('-v');
    const filteredArgs = args.filter((a) => !a.startsWith('-'));
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

    let blob: Blob;
    try {
      blob = await captureScreen(mimeType, quality);
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

    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (toClipboard) {
      try {
        const pngBlob = mimeType === 'image/png'
          ? blob
          : await (async () => {
              // Clipboard API requires PNG, convert if necessary
              const img = new Image();
              const url = URL.createObjectURL(blob);
              await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error('Failed to load image for conversion'));
                img.src = url;
              });
              URL.revokeObjectURL(url);

              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('Failed to get canvas context');
              ctx.drawImage(img, 0, 0);

              return new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((b) => {
                  if (b) resolve(b);
                  else reject(new Error('Failed to create PNG blob'));
                }, 'image/png');
              });
            })();

        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob }),
        ]);

        const sizeKB = Math.round(bytes.length / 1024);
        return {
          stdout: `captured ${sizeKB} KB to clipboard\n`,
          stderr: '',
          exitCode: 0,
        };
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
