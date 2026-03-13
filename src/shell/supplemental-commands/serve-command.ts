import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import type { BrowserAPI } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
import { getSharedState } from './playwright-command.js';
import { isSafeServeEntry, resolveServeEntryPath, toPreviewUrl } from './shared.js';

function serveHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: serve [--entry <relative-path>] [--project] <directory>\n\n' +
      '  Serve a VFS directory in a new browser tab via the preview service worker.\n' +
      '  Defaults to index.html inside the target directory.\n\n' +
      '  --entry    Override the entry file within the directory.\n' +
      '  --project  Enable project serve mode. Root-relative paths (/scripts/,\n' +
      '             /styles/, etc.) resolve against the served directory.\n' +
      '             Use this for frameworks like EDS that expect a local dev server.\n',
    stderr: '',
    exitCode: 0,
  };
}

function parseServeArgs(args: string[]): { directory?: string; entry: string; project: boolean; error?: string } {
  let entry = 'index.html';
  let directory: string | undefined;
  let project = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--entry') {
      const next = args[i + 1];
      if (!next) return { entry, project, error: 'serve: missing value for --entry\n' };
      entry = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--entry=')) {
      entry = arg.slice('--entry='.length);
      continue;
    }
    if (arg === '--project') {
      project = true;
      continue;
    }
    if (arg.startsWith('-')) {
      return { entry, project, error: `serve: unknown option: ${arg}\n` };
    }
    if (directory) {
      return { entry, project, error: 'serve: expected a single directory argument\n' };
    }
    directory = arg;
  }

  return { directory, entry, project };
}

export function createServeCommand(browserAPI?: BrowserAPI, vfs?: VirtualFS): Command {
  return defineCommand('serve', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return serveHelp();
    }

    // Need either BrowserAPI or window.open to open a tab
    const hasWindowOpen = typeof window !== 'undefined' && typeof window.open === 'function';
    if (!browserAPI && !hasWindowOpen) {
      return {
        stdout: '',
        stderr: 'serve: browser APIs are unavailable in this environment\n',
        exitCode: 1,
      };
    }

    const parsed = parseServeArgs(args);
    if (parsed.error) {
      return { stdout: '', stderr: parsed.error, exitCode: 1 };
    }
    if (!parsed.directory) {
      return serveHelp();
    }
    if (!isSafeServeEntry(parsed.entry)) {
      return {
        stdout: '',
        stderr: `serve: invalid entry file: ${parsed.entry}\n`,
        exitCode: 1,
      };
    }

    const fullDirectory = ctx.fs.resolvePath(ctx.cwd, parsed.directory);
    let directoryStat;
    try {
      directoryStat = await ctx.fs.stat(fullDirectory);
    } catch {
      return {
        stdout: '',
        stderr: `serve: no such directory: ${parsed.directory}\n`,
        exitCode: 1,
      };
    }
    if (!directoryStat.isDirectory) {
      return {
        stdout: '',
        stderr: `serve: not a directory: ${parsed.directory}\n`,
        exitCode: 1,
      };
    }

    const entryPath = resolveServeEntryPath(fullDirectory, parsed.entry);
    let entryStat;
    try {
      entryStat = await ctx.fs.stat(entryPath);
    } catch {
      return {
        stdout: '',
        stderr: `serve: entry file not found: ${entryPath}\n`,
        exitCode: 1,
      };
    }
    if (!entryStat.isFile) {
      return {
        stdout: '',
        stderr: `serve: entry is not a file: ${entryPath}\n`,
        exitCode: 1,
      };
    }

    let previewUrl = toPreviewUrl(entryPath);
    if (parsed.project) {
      previewUrl += `?projectRoot=${encodeURIComponent(fullDirectory)}`;
    }

    // Use BrowserAPI.createPage() when available — this integrates with
    // playwright-cli's tab tracking so the scoop can immediately use
    // screenshot/eval/snapshot on the served tab without tab-list + tab-select.
    if (browserAPI && vfs) {
      const targetId = await browserAPI.createPage(previewUrl);
      const pwState = getSharedState(browserAPI, vfs);
      pwState.currentTarget = targetId;
      return {
        stdout: `serving ${fullDirectory} → ${previewUrl} (targetId: ${targetId})\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    // Fallback: window.open() (no playwright-cli integration)
    // window.open() returns null in extension contexts (offscreen/side panel)
    // even when the tab opens successfully — don't treat null as failure
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(previewUrl, '_blank', 'noopener,noreferrer');
    }

    return {
      stdout: `serving ${fullDirectory} → ${previewUrl}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}