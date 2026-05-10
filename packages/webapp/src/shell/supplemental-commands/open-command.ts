import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { basename, detectMimeType, isLikelyUrl, toPreviewUrl } from './shared.js';

const FLAGS = ['--download', '-d', '--view', '-v'] as const;

function openHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: open [--download|-d] [--view|-v] <url|path> [url|path...]\n\n' +
      '  VFS paths are served in a new browser tab via the preview service worker.\n' +
      '  URLs (http/https/etc.) are opened directly in a new tab.\n' +
      '  For app directories with a default entry file, prefer serve <dir>.\n' +
      '  --download, -d  Force download instead of opening in a tab.\n' +
      '  --view, -v      Return image inline so the agent can see it.\n',
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
    const view = args.includes('--view') || args.includes('-v');
    const targets = args.filter((a) => !(FLAGS as readonly string[]).includes(a));

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

      // .shtml files → open as sprinkle via sprinkle manager
      if (fullPath.endsWith('.shtml')) {
        // Read from `globalThis` so the lookup works in both the page
        // realm (real `SprinkleManager`) and the kernel-worker realm
        // (BroadcastChannel-backed proxy published in
        // `kernel-worker.ts`).
        const mgr = (globalThis as Record<string, unknown>).__slicc_sprinkleManager as
          | import('../../ui/sprinkle-manager.js').SprinkleManager
          | undefined;
        if (mgr) {
          const name = (fullPath.split('/').pop() ?? '').replace(/\.shtml$/, '');
          try {
            await mgr.open(name);
            results.push(`opened sprinkle ${name} from ${fullPath}`);
          } catch (err) {
            return {
              stdout: '',
              stderr: `open: ${err instanceof Error ? err.message : String(err)}\n`,
              exitCode: 1,
            };
          }
        } else {
          // Fallback: open in browser tab if no sprinkle manager
          const previewUrl = toPreviewUrl(fullPath);
          window.open(previewUrl, '_blank', 'noopener,noreferrer');
          results.push(`opened ${fullPath} → ${previewUrl}`);
        }
        continue;
      }

      if (view) {
        // --view: read file and return as <img:> tag for agent vision
        let stat;
        try {
          stat = await ctx.fs.stat(fullPath);
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
          bytes = await ctx.fs.readFileBuffer(fullPath);
        } catch {
          return {
            stdout: '',
            stderr: `open: failed to read: ${target}\n`,
            exitCode: 1,
          };
        }
        const mimeType = detectMimeType(fullPath);
        const base64 = toBase64(new Uint8Array(bytes));
        results.push(
          `${fullPath} (${Math.round(bytes.byteLength / 1024)} KB)\n<img:data:${mimeType};base64,${base64}>`
        );
      } else if (download) {
        let stat;
        try {
          stat = await ctx.fs.stat(fullPath);
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
          bytes = await ctx.fs.readFileBuffer(fullPath);
        } catch {
          return {
            stdout: '',
            stderr: `open: failed to read: ${target}\n`,
            exitCode: 1,
          };
        }
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
