import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { basename, detectMimeType, isLikelyUrl, toPreviewUrl } from './shared.js';

function openHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: open [--download|-d] <url|path> [url|path...]\n\n' +
      '  VFS paths are served in a new browser tab via the preview service worker.\n' +
      '  URLs (http/https/etc.) are opened directly in a new tab.\n' +
      '  --download, -d  Force download instead of opening in a tab.\n',
    stderr: '',
    exitCode: 0,
  };
}

export function createOpenCommand(): Command {
  return defineCommand('open', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return openHelp();
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return {
        stdout: '',
        stderr: 'open: browser APIs are unavailable in this environment\n',
        exitCode: 1,
      };
    }

    const download = args.includes('--download') || args.includes('-d');
    const targets = args.filter((a) => a !== '--download' && a !== '-d');

    if (targets.length === 0) {
      return openHelp();
    }

    const results: string[] = [];

    for (const target of targets) {
      if (isLikelyUrl(target)) {
        // window.open() returns null in extension contexts (offscreen/side panel)
        // even when the tab opens successfully — don't treat null as failure
        window.open(target, '_blank', 'noopener,noreferrer');
        results.push(`opened ${target}`);
        continue;
      }

      const fullPath = ctx.fs.resolvePath(ctx.cwd, target);

      if (download) {
        const stat = await ctx.fs.stat(fullPath);
        if (!stat.isFile) {
          return {
            stdout: '',
            stderr: `open: not a file: ${target}\n`,
            exitCode: 1,
          };
        }

        const bytes = await ctx.fs.readFileBuffer(fullPath);
        const safeBytes = new Uint8Array(bytes.byteLength);
        safeBytes.set(bytes);
        const blob = new Blob([safeBytes.buffer], { type: detectMimeType(fullPath) });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = basename(fullPath) || 'download';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 0);
        results.push(`downloaded ${fullPath}`);
      } else {
        const previewUrl = toPreviewUrl(fullPath);
        // window.open() returns null in extension contexts (offscreen/side panel)
        // even when the tab opens successfully — don't treat null as failure
        window.open(previewUrl, '_blank', 'noopener,noreferrer');
        results.push(`opened ${fullPath} → ${previewUrl}`);
      }
    }

    return {
      stdout: results.join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  });
}
