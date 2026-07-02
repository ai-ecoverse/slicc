import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { BrowserAPI } from '../../cdp/index.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import {
  basename,
  detectMimeType,
  dirname,
  findProjectRoot,
  isLikelyUrl,
  toPreviewUrl,
} from './shared.js';

const FLAG_SET = new Set(['--download', '-d', '--view', '-v']);

const SIZE_PRESETS = { low: 256, medium: 768, high: 1536 } as const;
type SizePreset = keyof typeof SIZE_PRESETS;

function openHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: open [--download|-d] [--view|-v [--size <spec>]] <url|path> [url|path...]\n\n' +
      '  VFS paths are served in a new browser tab via the preview service worker.\n' +
      '  URLs (http/https/etc.) are opened directly in a new tab.\n' +
      '  For app directories with a default entry file, prefer serve <dir>.\n' +
      '  --download, -d  Force download instead of opening in a tab.\n' +
      '  --view, -v      Return image inline so the agent can see it.\n' +
      '                  Requires --size to bound how much context the image\n' +
      '                  consumes; without --size open prints the native\n' +
      '                  dimensions and exits non-zero.\n' +
      '  --size <spec>   Resize before inlining. Accepts presets low (256x256),\n' +
      '                  medium (768x768), high (1536x1536), or a custom WxH\n' +
      '                  box like 512x512. The image is fit inside the box\n' +
      '                  with aspect ratio preserved and is never upscaled.\n',
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

function parseSizeSpec(spec: string): { maxW: number; maxH: number } | null {
  if (spec in SIZE_PRESETS) {
    const v = SIZE_PRESETS[spec as SizePreset];
    return { maxW: v, maxH: v };
  }
  const m = /^(\d+)x(\d+)$/.exec(spec);
  if (m) {
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (w > 0 && h > 0) return { maxW: w, maxH: h };
  }
  return null;
}

/**
 * Detect whether the source bytes carry an alpha channel for formats
 * where re-encoding as JPEG would silently drop transparency. Header
 * parsing only — we don't need a full codec, just the right hint to
 * pick the output mime.
 */
function sourceHasAlpha(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/png' || mime === 'image/apng') {
    // 8-byte PNG signature, then IHDR: length(4) + 'IHDR'(4) + width(4)
    // + height(4) + bit_depth(1) + color_type(1). color_type is at
    // offset 25. 4 = grayscale+alpha, 6 = RGBA.
    if (bytes.length < 26) return false;
    const colorType = bytes[25];
    return colorType === 4 || colorType === 6;
  }
  if (mime === 'image/webp') {
    if (bytes.length < 16) return false;
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8L') return true; // lossless WebP is alpha-capable
    if (chunk === 'VP8X') {
      if (bytes.length < 21) return false;
      return (bytes[20] & 0x10) !== 0; // alpha flag bit
    }
    return false;
  }
  return false;
}

function sizeUsageHint(): string {
  return (
    'open --view requires --size to bound the inlined image. Use one of:\n' +
    '  --size low     (256x256)\n' +
    '  --size medium  (768x768)\n' +
    '  --size high    (1536x1536)\n' +
    '  --size WxH     (custom box, e.g. 512x512)\n'
  );
}

interface ResizedImage {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
}

// OffscreenCanvas.convertToBlob only reliably encodes image/png, image/webp,
// and image/jpeg. image/apng (and anything else with alpha) must be normalized
// to image/png on the alpha-preserving path.
const CANVAS_ALPHA_MIMES = new Set(['image/png', 'image/webp']);

function copyToFreshBuffer(sourceBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  // Copy to a fresh buffer so the Blob can't outlive the original
  // (the VFS read buffer is reused across calls).
  const buf = new ArrayBuffer(sourceBytes.byteLength);
  const safeBytes = new Uint8Array(buf);
  safeBytes.set(sourceBytes);
  return safeBytes;
}

async function decodeDimensions(
  sourceBytes: Uint8Array,
  sourceMime: string
): Promise<{ width: number; height: number }> {
  const safeBytes = copyToFreshBuffer(sourceBytes);
  const blob = new Blob([safeBytes], { type: sourceMime });
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close?.();
  }
}

async function decodeAndResize(
  sourceBytes: Uint8Array,
  sourceMime: string,
  maxW: number,
  maxH: number
): Promise<ResizedImage> {
  const safeBytes = copyToFreshBuffer(sourceBytes);
  const blob = new Blob([safeBytes], { type: sourceMime });
  const bitmap = await createImageBitmap(blob);
  try {
    const nativeWidth = bitmap.width;
    const nativeHeight = bitmap.height;
    // Never upscale — scale is capped at 1.
    const scale = Math.min(maxW / nativeWidth, maxH / nativeHeight, 1);
    const targetW = Math.max(1, Math.round(nativeWidth * scale));
    const targetH = Math.max(1, Math.round(nativeHeight * scale));
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('failed to acquire 2d context for resize');
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    const preserveAlpha = sourceHasAlpha(sourceBytes, sourceMime);
    const outMime = preserveAlpha
      ? CANVAS_ALPHA_MIMES.has(sourceMime)
        ? sourceMime
        : 'image/png'
      : 'image/jpeg';
    const blobOut = await canvas.convertToBlob(
      outMime === 'image/jpeg' ? { type: 'image/jpeg', quality: 0.85 } : { type: outMime }
    );
    const outBytes = new Uint8Array(await blobOut.arrayBuffer());
    return {
      bytes: outBytes,
      mime: outMime,
      width: targetW,
      height: targetH,
      nativeWidth,
      nativeHeight,
    };
  } finally {
    bitmap.close?.();
  }
}

interface ParsedArgs {
  download: boolean;
  view: boolean;
  sizeSpec: string | undefined;
  targets: string[];
  error?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    download: false,
    view: false,
    sizeSpec: undefined,
    targets: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--download' || a === '-d') {
      out.download = true;
    } else if (a === '--view' || a === '-v') {
      out.view = true;
    } else if (a === '--size') {
      const next = args[i + 1];
      if (
        next === undefined ||
        FLAG_SET.has(next) ||
        next === '--size' ||
        next.startsWith('--size=')
      ) {
        out.error = 'open: --size requires a value (low|medium|high|WxH)';
        return out;
      }
      out.sizeSpec = next;
      i++;
    } else if (a.startsWith('--size=')) {
      out.sizeSpec = a.slice('--size='.length);
    } else {
      out.targets.push(a);
    }
  }
  return out;
}

export function createOpenCommand(browserAPI?: BrowserAPI): Command {
  return defineCommand('open', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return openHelp();
    }

    const parsed = parseArgs(args);
    if (parsed.error) {
      return { stdout: '', stderr: `${parsed.error}\n`, exitCode: 1 };
    }
    const { download, view, sizeSpec, targets } = parsed;

    if (targets.length === 0) {
      return openHelp();
    }

    // `.shtml` opens go through the sprinkle manager, which is published
    // on `globalThis.__slicc_sprinkleManager` in BOTH realms — the
    // kernel-worker (where it's a BroadcastChannel-backed proxy) and the
    // page (where it's the real `SprinkleManager`). The shell command
    // runs in the worker, which has no `window` / `document`; gating
    // every code path behind that DOM check would block this branch
    // even though it doesn't need a DOM. Detect a sprinkle target up
    // front and run it before the DOM guard kicks in.
    const sprinkleManager = (globalThis as Record<string, unknown>).__slicc_sprinkleManager as
      | import('../../ui/sprinkle-manager.js').SprinkleManager
      | undefined;
    const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
    const panelRpc = !hasDom ? getPanelRpcClient() : null;
    const canOpenWindow = !!browserAPI || hasDom || !!panelRpc;
    /**
     * Open a URL in a new tab. Returns the CDP targetId when `browserAPI`
     * is available (aligns `open`'s output with `serve`'s), or `undefined`
     * on the plain `window.open`/panel-RPC fallback paths. Throws an Error
     * with a stable `open:` prefix on the bridged path so callers can rely
     * on a consistent error shape (panel-RPC rejections — handler not
     * installed, timeout — would otherwise bubble as raw `panel-rpc: …`
     * strings). Callers wrap this in try/catch to map to a `{ stderr,
     * exitCode }` result.
     */
    const openExternal = async (url: string): Promise<string | undefined> => {
      if (browserAPI) {
        return browserAPI.createPage(url);
      }
      if (hasDom) {
        // window.open() returns null in extension contexts (offscreen/
        // side panel) even when the tab opens successfully — don't
        // treat null as failure.
        window.open(url, '_blank', 'noopener,noreferrer');
        return undefined;
      }
      try {
        await panelRpc!.call('window-open', {
          url,
          target: '_blank',
          features: 'noopener,noreferrer',
        });
      } catch (err) {
        throw new Error(`open: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    };

    const targetIdSuffix = (targetId: string | undefined): string =>
      targetId ? ` (targetId: ${targetId})` : '';

    const results: string[] = [];

    for (const target of targets) {
      // .shtml targets go through the sprinkle manager (which is a
      // BroadcastChannel proxy in the worker realm and the real
      // SprinkleManager in the page realm). This branch must run
      // BEFORE the DOM availability check because the worker has no
      // `window` / `document` but can still RPC the page's manager.
      if (!isLikelyUrl(target) && target.endsWith('.shtml') && ctx.fs) {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
        if (sprinkleManager) {
          const name = (fullPath.split('/').pop() ?? '').replace(/\.shtml$/, '');
          try {
            await sprinkleManager.open(name);
            results.push(`opened sprinkle ${name} from ${fullPath}`);
          } catch (err) {
            return {
              stdout: '',
              stderr: `open: ${err instanceof Error ? err.message : String(err)}\n`,
              exitCode: 1,
            };
          }
        } else if (canOpenWindow) {
          const projectRoot = await findProjectRoot(ctx.fs, dirname(fullPath));
          const previewUrl = toPreviewUrl(fullPath, projectRoot);
          let targetId: string | undefined;
          try {
            targetId = await openExternal(previewUrl);
          } catch (err) {
            return {
              stdout: '',
              stderr: `${err instanceof Error ? err.message : String(err)}\n`,
              exitCode: 1,
            };
          }
          results.push(`opened ${fullPath} → ${previewUrl}${targetIdSuffix(targetId)}`);
        } else {
          return {
            stdout: '',
            stderr: 'open: sprinkle manager not initialized\n',
            exitCode: 1,
          };
        }
        continue;
      }

      // `--view` only needs file I/O + base64 (no DOM); every other
      // mode needs either a DOM (anchor-click download) or a way to
      // open a tab (`canOpenWindow`). Bail early when no mode applies.
      if (!view && !canOpenWindow) {
        return {
          stdout: '',
          stderr: 'open: browser APIs are unavailable in this environment\n',
          exitCode: 1,
        };
      }

      if (isLikelyUrl(target)) {
        if (!canOpenWindow) {
          return {
            stdout: '',
            stderr: 'open: browser APIs are unavailable in this environment\n',
            exitCode: 1,
          };
        }
        let targetId: string | undefined;
        try {
          targetId = await openExternal(target);
        } catch (err) {
          return {
            stdout: '',
            stderr: `${err instanceof Error ? err.message : String(err)}\n`,
            exitCode: 1,
          };
        }
        results.push(`opened ${target}${targetIdSuffix(targetId)}`);
        continue;
      }

      const path = ctx.fs.resolvePath(ctx.cwd, target);

      if (view) {
        // --view: read file, decode as image, and return the resized
        // image as an <img:> tag for agent vision. Without --size we
        // refuse to inline raw bytes — a single un-bounded image can
        // blow the tool-result token budget.
        let stat;
        try {
          stat = await ctx.fs.stat(path);
        } catch {
          return {
            stdout: '',
            stderr: `open: no such file: ${target}\n`,
            exitCode: 1,
          };
        }
        if (!stat.isFile) {
          return {
            stdout: '',
            stderr: `open: not a file: ${target}\n`,
            exitCode: 1,
          };
        }
        let bytes;
        try {
          bytes = await ctx.fs.readFileBuffer(path);
        } catch {
          return {
            stdout: '',
            stderr: `open: failed to read: ${target}\n`,
            exitCode: 1,
          };
        }
        const sourceMime = detectMimeType(path);
        const sourceBytes = new Uint8Array(bytes);

        let parsedSize: { maxW: number; maxH: number } | null = null;
        if (sizeSpec !== undefined) {
          parsedSize = parseSizeSpec(sizeSpec);
          if (!parsedSize) {
            return {
              stdout: '',
              stderr:
                `open: invalid --size spec '${sizeSpec}' ` +
                `(expected low|medium|high or WxH such as 512x512)\n`,
              exitCode: 1,
            };
          }
        }

        if (!parsedSize) {
          // No --size: only the native dimensions are needed for the
          // usage hint. Skip the canvas/convertToBlob round-trip so a
          // missing --size doesn't allocate an OffscreenCanvas at
          // native resolution and re-encode the full image.
          let dims;
          try {
            dims = await decodeDimensions(sourceBytes, sourceMime);
          } catch (err) {
            return {
              stdout: '',
              stderr:
                `open: not an image or failed to decode: ${target} ` +
                `(${err instanceof Error ? err.message : String(err)})\n`,
              exitCode: 1,
            };
          }
          const kb = Math.round(sourceBytes.byteLength / 1024);
          return {
            stdout: '',
            stderr:
              `open --view: ${path} is ${dims.width}x${dims.height} ` +
              `(${kb} KB, ${sourceMime})\n` +
              sizeUsageHint(),
            exitCode: 1,
          };
        }

        let resized: ResizedImage;
        try {
          resized = await decodeAndResize(
            sourceBytes,
            sourceMime,
            parsedSize.maxW,
            parsedSize.maxH
          );
        } catch (err) {
          return {
            stdout: '',
            stderr:
              `open: not an image or failed to decode: ${target} ` +
              `(${err instanceof Error ? err.message : String(err)})\n`,
            exitCode: 1,
          };
        }

        const base64 = toBase64(resized.bytes);
        const outKb = Math.round(resized.bytes.byteLength / 1024);
        results.push(
          `${path} (${resized.nativeWidth}x${resized.nativeHeight} → ` +
            `${resized.width}x${resized.height}, ${outKb} KB, ${resized.mime})\n` +
            `<img:data:${resized.mime};base64,${base64}>`
        );
      } else if (download) {
        if (!hasDom) {
          // Anchor-click download requires DOM; the bridge can't fake
          // a browser download trigger from the page without surfacing
          // the bytes through a transient blob URL on its own, which
          // would still need the user to be on the page. Surface a
          // clear error rather than silently failing.
          return {
            stdout: '',
            stderr: 'open: --download requires the in-panel terminal (DOM-only)\n',
            exitCode: 1,
          };
        }
        let stat;
        try {
          stat = await ctx.fs.stat(path);
        } catch {
          return {
            stdout: '',
            stderr: `open: no such file: ${target}\n`,
            exitCode: 1,
          };
        }
        if (!stat.isFile) {
          return {
            stdout: '',
            stderr: `open: not a file: ${target}\n`,
            exitCode: 1,
          };
        }

        let bytes;
        try {
          bytes = await ctx.fs.readFileBuffer(path);
        } catch {
          return {
            stdout: '',
            stderr: `open: failed to read: ${target}\n`,
            exitCode: 1,
          };
        }
        const safeBytes = new Uint8Array(bytes.byteLength);
        safeBytes.set(bytes);
        const blob = new Blob([safeBytes.buffer], { type: detectMimeType(path) });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = basename(path) || 'download';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 0);
        results.push(`downloaded ${path}`);
      } else {
        if (!canOpenWindow) {
          return {
            stdout: '',
            stderr: 'open: browser APIs are unavailable in this environment\n',
            exitCode: 1,
          };
        }
        const projectRoot = await findProjectRoot(ctx.fs, dirname(path));
        const previewUrl = toPreviewUrl(path, projectRoot);
        let targetId: string | undefined;
        try {
          targetId = await openExternal(previewUrl);
        } catch (err) {
          return {
            stdout: '',
            stderr: `${err instanceof Error ? err.message : String(err)}\n`,
            exitCode: 1,
          };
        }
        results.push(`opened ${path} → ${previewUrl}${targetIdSuffix(targetId)}`);
      }
    }

    return {
      stdout: results.join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  });
}
