import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { getMimeType, isTerminalPreviewableMimeType } from '../../core/mime-types.js';

export interface MediaPreviewItem {
  path: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ImgcatCommandOptions {
  onMediaPreview?: (items: MediaPreviewItem[]) => Promise<void> | void;
}

function imgcatHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `imgcat - preview image and video files in the preview tab

Usage: imgcat <path> [path...]

Options:
  -h, --help    Show this help message
`,
    stderr: '',
    exitCode: 0,
  };
}

export function createImgcatCommand(options: ImgcatCommandOptions = {}): Command {
  return defineCommand('imgcat', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return imgcatHelp();
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return {
        stdout: '',
        stderr: 'imgcat: browser APIs are unavailable in this environment\n',
        exitCode: 1,
      };
    }
    if (!options.onMediaPreview) {
      return {
        stdout: '',
        stderr: 'imgcat: terminal preview is unavailable\n',
        exitCode: 1,
      };
    }

    const previewItems: MediaPreviewItem[] = [];

    for (const target of args) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
      const stat = await ctx.fs.stat(fullPath);
      if (!stat.isFile) {
        return {
          stdout: '',
          stderr: `imgcat: not a file: ${target}\n`,
          exitCode: 1,
        };
      }

      const mimeType = getMimeType(fullPath);
      if (!isTerminalPreviewableMimeType(mimeType)) {
        return {
          stdout: '',
          stderr: `imgcat: unsupported media type: ${target}\n`,
          exitCode: 1,
        };
      }

      const bytes = await ctx.fs.readFileBuffer(fullPath);
      const safeBytes = new Uint8Array(bytes.byteLength);
      safeBytes.set(bytes);
      previewItems.push({ path: fullPath, mimeType, bytes: safeBytes });
    }

    try {
      await options.onMediaPreview(previewItems);
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: `imgcat: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
