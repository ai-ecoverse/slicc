import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { basename, detectMimeType, isLikelyUrl, toPreviewUrl } from './shared.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';

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

    const download = args.includes('--download') || args.includes('-d');
    const view = args.includes('--view') || args.includes('-v');
    const targets = args.filter((a) => !(FLAGS as readonly string[]).includes(a));

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
    const canOpenWindow = hasDom || !!panelRpc;
    /**
     * Open a URL in a new tab. Throws an Error with a stable `open:`
     * prefix on the bridged path so callers can rely on a consistent
     * error shape (panel-RPC rejections — handler not installed,
     * timeout — would otherwise bubble as raw `panel-rpc: …` strings).
     * Callers wrap this in try/catch to map to a `{ stderr, exitCode }`
     * result.
     */
    const openExternal = async (url: string): Promise<void> => {
      if (hasDom) {
        // window.open() returns null in extension contexts (offscreen/
        // side panel) even when the tab opens successfully — don't
        // treat null as failure.
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
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
    };

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
          const previewUrl = toPreviewUrl(fullPath);
          try {
            await openExternal(previewUrl);
          } catch (err) {
            return {
              stdout: '',
              stderr: `${err instanceof Error ? err.message : String(err)}\n`,
              exitCode: 1,
            };
          }
          results.push(`opened ${fullPath} → ${previewUrl}`);
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
        try {
          await openExternal(target);
        } catch (err) {
          return {
            stdout: '',
            stderr: `${err instanceof Error ? err.message : String(err)}\n`,
            exitCode: 1,
          };
        }
        results.push(`opened ${target}`);
        continue;
      }

      const path = ctx.fs.resolvePath(ctx.cwd, target);

      if (view) {
        // --view: read file and return as <img:> tag for agent vision
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
        const mimeType = detectMimeType(path);
        const base64 = toBase64(new Uint8Array(bytes));
        results.push(
          `${path} (${Math.round(bytes.byteLength / 1024)} KB)\n<img:data:${mimeType};base64,${base64}>`
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
        const previewUrl = toPreviewUrl(path);
        try {
          await openExternal(previewUrl);
        } catch (err) {
          return {
            stdout: '',
            stderr: `${err instanceof Error ? err.message : String(err)}\n`,
            exitCode: 1,
          };
        }
        results.push(`opened ${path} → ${previewUrl}`);
      }
    }

    return {
      stdout: results.join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  });
}
