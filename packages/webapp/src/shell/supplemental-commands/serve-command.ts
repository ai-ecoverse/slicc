import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { BrowserAPI } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import {
  getPreviewMinter,
  getPreviewOp,
  type MintPreviewResult,
} from '../../scoops/preview-minter.js';
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
 *    `getPreviewOp()` handles `--stop` / `--list` via the same pattern.
 *
 *  - **Cross-realm**: standalone kernel-worker shell → page-side via
 *    the panel-RPC `tray-open-preview` / `tray-revoke-preview` /
 *    `tray-list-previews` ops. The page-side handler
 *    (wired in `ui/boot/setup-standalone-panel-rpc.ts`) reaches
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
 *  - `--stop <token>` revokes a previously-minted preview token.
 *  - `--list` lists active previews on the tray.
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
      '  --stop <t>   Revoke a previously-minted preview token.\n' +
      '  --list       List active previews on this tray.\n' +
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

type ArgStepResult = { skip: number } | { error: string };

function isArgError(r: ArgStepResult): r is { error: string } {
  return 'error' in r;
}

function parseOneFlag(
  arg: string,
  nextArg: string | undefined,
  state: ParsedServeArgs
): ArgStepResult {
  if (arg === '--entry') {
    if (!nextArg) return { error: 'serve: missing value for --entry\n' };
    state.entry = nextArg;
    return { skip: 1 };
  }
  if (arg.startsWith('--entry=')) {
    state.entry = arg.slice('--entry='.length);
    return { skip: 0 };
  }
  if (arg === '--bridge') {
    state.bridge = true;
    return { skip: 0 };
  }
  if (arg === '--no-bridge') {
    state.noBridge = true;
    return { skip: 0 };
  }
  if (arg === '--project') {
    state.project = true;
    return { skip: 0 };
  }
  if (arg === '--stop') {
    if (!nextArg) return { error: 'serve: missing value for --stop\n' };
    state.stop = nextArg;
    return { skip: 1 };
  }
  if (arg.startsWith('--stop=')) {
    state.stop = arg.slice('--stop='.length);
    return { skip: 0 };
  }
  if (arg === '--list') {
    state.list = true;
    return { skip: 0 };
  }
  if (arg.startsWith('-')) {
    return { error: `serve: unknown option: ${arg}\n` };
  }
  if (state.directory) {
    return { error: 'serve: expected a single directory argument\n' };
  }
  state.directory = arg;
  return { skip: 0 };
}

function parseUnifiedArgs(args: string[]): ParsedServeArgs {
  const state: ParsedServeArgs = {
    entry: 'index.html',
    bridge: false,
    noBridge: false,
    project: false,
    list: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const step = parseOneFlag(args[i]!, args[i + 1], state);
    if (isArgError(step)) {
      return { ...state, error: step.error };
    }
    i += step.skip;
  }

  return state;
}

interface ServeValidation {
  fullDirectory: string;
  entryPath: string;
}

type ServeResult = { stdout: string; stderr: string; exitCode: number };

async function validateServeTarget(
  directory: string,
  entry: string,
  fs: {
    resolvePath(base: string, rel: string): string;
    stat(p: string): Promise<{ isDirectory: boolean; isFile: boolean }>;
  },
  cwd: string
): Promise<ServeValidation | ServeResult> {
  if (!isSafeServeEntry(entry)) {
    return { stdout: '', stderr: `serve: invalid entry file: ${entry}\n`, exitCode: 1 };
  }

  const fullDirectory = fs.resolvePath(cwd, directory);
  let directoryStat;
  try {
    directoryStat = await fs.stat(fullDirectory);
  } catch {
    return { stdout: '', stderr: `serve: no such directory: ${directory}\n`, exitCode: 1 };
  }
  if (!directoryStat.isDirectory) {
    return { stdout: '', stderr: `serve: not a directory: ${directory}\n`, exitCode: 1 };
  }

  const entryPath = resolveServeEntryPath(fullDirectory, entry);
  let entryStat;
  try {
    entryStat = await fs.stat(entryPath);
  } catch {
    return { stdout: '', stderr: `serve: entry file not found: ${entryPath}\n`, exitCode: 1 };
  }
  if (!entryStat.isFile) {
    return { stdout: '', stderr: `serve: entry is not a file: ${entryPath}\n`, exitCode: 1 };
  }

  return { fullDirectory, entryPath };
}

function isValidationError(v: ServeValidation | ServeResult): v is ServeResult {
  return 'exitCode' in v;
}

async function stopPreview(token: string): Promise<ServeResult> {
  const inRealm = getPreviewOp();
  if (inRealm) {
    const result = await inRealm({ type: 'stop', previewToken: token });
    if (!result.revoked) {
      return {
        stdout: '',
        stderr: `serve: preview token not found or already revoked\n`,
        exitCode: 1,
      };
    }
    return { stdout: `Preview revoked: ${token}\n`, stderr: '', exitCode: 0 };
  }
  const rpc = getPanelRpcClient();
  if (!rpc) {
    return {
      stdout: '',
      stderr:
        'serve: no leader tray available. Enable multi-browser sync via `host enable` or the avatar popover.\n',
      exitCode: 1,
    };
  }
  const result = await rpc.call('tray-revoke-preview', { previewToken: token });
  if (!result.revoked) {
    return {
      stdout: '',
      stderr: `serve: preview token not found or already revoked\n`,
      exitCode: 1,
    };
  }
  return { stdout: `Preview revoked: ${token}\n`, stderr: '', exitCode: 0 };
}

async function listPreviews(): Promise<ServeResult> {
  const inRealm = getPreviewOp();
  if (inRealm) {
    const result = await inRealm({ type: 'list' });
    const previews = result.previews ?? [];
    if (previews.length === 0) {
      return { stdout: 'No active previews\n', stderr: '', exitCode: 0 };
    }
    const lines = previews.map(
      (p) => `  ${p.previewToken}  ${p.url}  ${p.servedRoot}  ${p.createdAt}\n`
    );
    return { stdout: `Active previews:\n${lines.join('')}`, stderr: '', exitCode: 0 };
  }
  const rpc = getPanelRpcClient();
  if (!rpc) {
    return {
      stdout: '',
      stderr:
        'serve: no leader tray available. Enable multi-browser sync via `host enable` or the avatar popover.\n',
      exitCode: 1,
    };
  }
  const result = await rpc.call('tray-list-previews', undefined);
  const previews = result.previews ?? [];
  if (previews.length === 0) {
    return { stdout: 'No active previews\n', stderr: '', exitCode: 0 };
  }
  const lines = previews.map(
    (p) => `  ${p.previewToken}  ${p.url}  ${p.servedRoot}  ${p.createdAt}\n`
  );
  return { stdout: `Active previews:\n${lines.join('')}`, stderr: '', exitCode: 0 };
}

interface MintOpts {
  entryPath: string;
  servedRoot: string;
  bridge: boolean;
  noBridge: boolean;
}

function withServeError(fn: () => Promise<ServeResult>): Promise<ServeResult> {
  return fn().catch((err) => ({
    stdout: '',
    stderr: `serve: ${err instanceof Error ? err.message : String(err)}\n`,
    exitCode: 1,
  }));
}

async function mintPreview(opts: MintOpts): Promise<MintPreviewResult> {
  const inRealm = getPreviewMinter();
  if (inRealm) {
    return inRealm(opts);
  }
  const rpc = getPanelRpcClient();
  if (!rpc) {
    throw new Error(
      'no leader tray available. ' +
        'Enable multi-browser sync via `host enable` or the avatar popover.'
    );
  }
  return rpc.call('tray-open-preview', opts);
}

async function openPreviewTab(url: string, browserAPI?: BrowserAPI): Promise<void> {
  if (browserAPI) {
    await browserAPI.createPage(url);
  } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
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

    if (parsed.stop) {
      const stopToken = parsed.stop;
      return await withServeError(() => stopPreview(stopToken));
    }
    if (parsed.list) {
      return await withServeError(() => listPreviews());
    }

    if (!parsed.directory) {
      return serveHelp();
    }

    const validation = await validateServeTarget(parsed.directory, parsed.entry, ctx.fs, ctx.cwd);
    if (isValidationError(validation)) {
      return validation;
    }
    const { fullDirectory, entryPath } = validation;

    const deprecationNotice = parsed.project
      ? 'serve: --project is obsolete; ignored (root-absolute paths work natively under unified preview)\n'
      : '';

    let result: MintPreviewResult;
    try {
      result = await mintPreview({
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

    await openPreviewTab(result.url, browserAPI);

    const followerLabel = `${result.pushed} follower${result.pushed === 1 ? '' : 's'}`;
    return {
      stdout: `Preview URL: ${result.url}\nPushed to ${followerLabel}\n`,
      stderr: deprecationNotice,
      exitCode: 0,
    };
  });
}
