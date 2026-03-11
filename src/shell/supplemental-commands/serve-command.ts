import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { isSafeServeEntry, resolveServeEntryPath, toPreviewUrl } from './shared.js';

function serveHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: serve [--entry <relative-path>|--entry=<relative-path>] <directory>\n\n' +
      '  Serve a VFS directory in a new browser tab via the preview service worker.\n' +
      '  Defaults to index.html inside the target directory.\n' +
      '  --entry  Override the entry file within the directory.\n',
    stderr: '',
    exitCode: 0,
  };
}

function parseServeArgs(args: string[]): { directory?: string; entry: string; error?: string } {
  let entry = 'index.html';
  let directory: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--entry') {
      const next = args[i + 1];
      if (!next) return { entry, error: 'serve: missing value for --entry\n' };
      entry = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--entry=')) {
      entry = arg.slice('--entry='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      return { entry, error: `serve: unknown option: ${arg}\n` };
    }
    if (directory) {
      return { entry, error: 'serve: expected a single directory argument\n' };
    }
    directory = arg;
  }

  return { directory, entry };
}

export function createServeCommand(): Command {
  return defineCommand('serve', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return serveHelp();
    }

    if (typeof window === 'undefined' || typeof window.open !== 'function') {
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

    const previewUrl = toPreviewUrl(entryPath);
    // window.open() returns null in extension contexts (offscreen/side panel)
    // even when the tab opens successfully — don't treat null as failure
    window.open(previewUrl, '_blank', 'noopener,noreferrer');

    return {
      stdout: `serving ${fullDirectory} → ${previewUrl}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}