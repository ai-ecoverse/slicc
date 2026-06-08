import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { BrowserAPI } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import { getPreviewMinter, type MintPreviewResult } from '../../scoops/preview-minter.js';
import { isSafeServeEntry, resolveServeEntryPath } from './shared.js';

/**
 * `serve` — mint a worker-hosted preview URL for a VFS directory and
 * broadcast it to followers.
 *
 * Two-context mint surface (the offscreen kernel-worker shell sees both):
 *
 *  - **In-realm**: `getPreviewMinter()` returns a non-null minter when
 *    the extension agent (offscreen) or the extension panel terminal
 *    (also in offscreen via `RemoteTerminalView`) has registered one
 *    via `setPreviewMinter(...)`. Same-realm call, no cross-realm hop.
 *
 *  - **Cross-realm**: standalone kernel-worker shell → page-side via
 *    the panel-RPC `tray-open-preview` op. The page-side handler
 *    (wired in `ui/main.ts` and `ui/panel-rpc-handlers.ts`) reaches
 *    `LeaderSyncManager` and the worker HTTP API.
 *
 * Flags:
 *  - `--entry <path>` overrides the entry file (default: index.html).
 *  - `--bridge` / `--no-bridge` are intent flags. The effective
 *    `allowLive` is computed at the mint site (Task 17 will extend
 *    `MintPreviewOpts` to take both; until then we pass the resolved
 *    boolean through `allowLive` on the in-realm path and the raw
 *    `bridge` / `noBridge` pair on the panel-RPC payload).
 *  - `--project` is obsolete — root-absolute paths work natively
 *    under unified preview. Prints a deprecation warning to stderr
 *    but still mints.
 *  - `--stop <token>` and `--list` are parsed but deferred to a
 *    follow-up (Phase 1b). They return exit 1 with a clear message.
 */
function serveHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: serve [--entry <relative-path>] [--bridge | --no-bridge] [--stop <token>] [--list] <directory>\n\n' +
      '  Mint a worker-hosted preview URL for a VFS directory, broadcast it to\n' +
      "  all connected followers, and open it in the leader's browser.\n\n" +
      '  --entry      Override the entry file within the directory (default: index.html).\n' +
      '  --bridge     Opt in to leader-managed live updates (Phase 2).\n' +
      '  --no-bridge  Force the live bridge OFF even when followers are Cherry-attached.\n' +
      '  --stop <t>   Revoke a previously-minted preview token (coming soon).\n' +
      '  --list       List active previews on this tray (coming soon).\n' +
      '  --project    Obsolete; ignored. Root-absolute paths work natively\n' +
      '               under unified preview.\n',
    stderr: '',
    exitCode: 0,
  };
}

interface ParsedServeArgs {
  directory?: string;
  entry: string;
  bridge: boolean;
  noBridge: boolean;
  project: boolean;
  stop?: string;
  list: boolean;
  error?: string;
}

function parseUnifiedArgs(args: string[]): ParsedServeArgs {
  let entry = 'index.html';
  let directory: string | undefined;
  let bridge = false;
  let noBridge = false;
  let project = false;
  let stop: string | undefined;
  let list = false;

  const fail = (message: string): ParsedServeArgs => ({
    entry,
    bridge,
    noBridge,
    project,
    list,
    error: message,
  });

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--entry') {
      const next = args[i + 1];
      if (!next) return fail('serve: missing value for --entry\n');
      entry = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--entry=')) {
      entry = arg.slice('--entry='.length);
      continue;
    }
    if (arg === '--bridge') {
      bridge = true;
      continue;
    }
    if (arg === '--no-bridge') {
      noBridge = true;
      continue;
    }
    if (arg === '--project') {
      project = true;
      continue;
    }
    if (arg === '--stop') {
      const next = args[i + 1];
      if (!next) return fail('serve: missing value for --stop\n');
      stop = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--stop=')) {
      stop = arg.slice('--stop='.length);
      continue;
    }
    if (arg === '--list') {
      list = true;
      continue;
    }
    if (arg.startsWith('-')) {
      return fail(`serve: unknown option: ${arg}\n`);
    }
    if (directory) {
      return fail('serve: expected a single directory argument\n');
    }
    directory = arg;
  }

  return { directory, entry, bridge, noBridge, project, stop, list };
}

export function createServeCommand(browserAPI?: BrowserAPI, _vfs?: VirtualFS): Command {
  return defineCommand('serve', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return serveHelp();
    }

    const parsed = parseUnifiedArgs(args);
    if (parsed.error) {
      return { stdout: '', stderr: parsed.error, exitCode: 1 };
    }

    // v1 scope: --stop and --list are parsed (so the parser doesn't choke
    // on them) but defer to a follow-up commit. They need either an
    // extended in-realm minter API (kind: 'stop' | 'list') or new
    // panel-RPC ops; keeping Task 16 focused on the mint path.
    if (parsed.stop) {
      return {
        stdout: '',
        stderr: 'serve: --stop is not yet implemented; coming in a follow-up\n',
        exitCode: 1,
      };
    }
    if (parsed.list) {
      return {
        stdout: '',
        stderr: 'serve: --list is not yet implemented; coming in a follow-up\n',
        exitCode: 1,
      };
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

    // --project is now an obsolete no-op alias. Warn loudly but continue.
    let deprecationNotice = '';
    if (parsed.project) {
      deprecationNotice =
        'serve: --project is obsolete; ignored (root-absolute paths work natively under unified preview)\n';
    }

    // Resolve effective allowLive locally for the in-realm path. The
    // panel-RPC path forwards raw intent and lets the page-side handler
    // (which has access to leader-side state Cherry attachment etc.)
    // compute it.
    //
    // --no-bridge wins over --bridge per the spec; the default is false.
    const allowLive = parsed.bridge && !parsed.noBridge;

    // Two-context mint: in-realm minter (extension) → panel-RPC
    // (standalone). Auto-enable of the tray when no leader is active
    // is out of scope for v1; if the mint fails because there's no
    // leader, we surface the error with a hint to enable multi-browser
    // sync.
    let result: MintPreviewResult;
    const inRealm = getPreviewMinter();
    if (inRealm) {
      try {
        result = await inRealm({
          entryPath,
          servedRoot: fullDirectory,
          allowLive,
        });
      } catch (err) {
        return {
          stdout: '',
          stderr: `${deprecationNotice}serve: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    } else {
      const rpc = getPanelRpcClient();
      if (!rpc) {
        return {
          stdout: '',
          stderr:
            `${deprecationNotice}serve: no leader tray available. ` +
            'Enable multi-browser sync via `host enable` or the avatar popover.\n',
          exitCode: 1,
        };
      }
      try {
        result = await rpc.call('tray-open-preview', {
          entryPath,
          servedRoot: fullDirectory,
          bridge: parsed.bridge,
          noBridge: parsed.noBridge,
        });
      } catch (err) {
        return {
          stdout: '',
          stderr: `${deprecationNotice}serve: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    }

    // Open the leader's tab. BrowserAPI integrates with playwright-cli's
    // tab tracking; window.open is the fallback. In extension contexts
    // (offscreen / side panel) window.open returns null even on success
    // — fire-and-forget per docs/pitfalls.md.
    if (browserAPI) {
      await browserAPI.createPage(result.url);
    } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(result.url, '_blank', 'noopener,noreferrer');
    }

    const followerLabel = `${result.pushed} follower${result.pushed === 1 ? '' : 's'}`;
    return {
      stdout: `Preview URL: ${result.url}\nPushed to ${followerLabel}\n`,
      stderr: deprecationNotice,
      exitCode: 0,
    };
  });
}
