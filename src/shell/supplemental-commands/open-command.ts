import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { basename, detectMimeType, isLikelyUrl } from './shared.js';

function openHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: open <url|path> [url|path...]\n',
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

    let openedTabs = 0;
    let downloadedFiles = 0;

    for (const target of args) {
      if (isLikelyUrl(target)) {
        const tab = window.open(target, '_blank', 'noopener,noreferrer');
        if (!tab) {
          return {
            stdout: '',
            stderr: `open: failed to open URL: ${target}\n`,
            exitCode: 1,
          };
        }
        openedTabs++;
        continue;
      }

      const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
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
      downloadedFiles++;
    }

    return {
      stdout: `opened ${openedTabs} tab(s), downloaded ${downloadedFiles} file(s)\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}
