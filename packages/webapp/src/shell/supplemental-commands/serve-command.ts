import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import type { BrowserAPI } from '../../kernel/browser-api.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import {
  getPreviewMinter,
  getPreviewOp,
  type MintPreviewResult,
  type PreviewLifecycleRecordResult,
} from '../preview-minter.js';
import { getLickManagerSurface } from './lick-surface.js';
import { detectMimeType, isSafeServeEntry, resolveServeEntryPath } from './shared.js';

const PERSISTENT_PREVIEW_RPC_TIMEOUT_MS = 10 * 60_000;

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
 *    `getPreviewOp()` handles `--stop` / `--list` / `logs` / `truncate`
 *    via the same pattern.
 *
 *  - **Cross-realm**: standalone kernel-worker shell → page-side via
 *    the panel-RPC `tray-open-preview` / `tray-revoke-preview` /
 *    `tray-list-previews` / preview lifecycle ops. The page-side handler
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
 *  - `--logs [<token>]` prints leader-memory-only preview lifecycle diagnostics.
 *  - `--truncate [<token>]` clears diagnostics and re-arms the announcement latch.
 */
function serveHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: serve [--entry <relative-path>] [--ttl <duration>] [--bridge | --no-bridge] [--max-tabs <n>] [--quiet] [--stop <token>] [--list] <directory>\n' +
      '       serve --logs [<token>] [--lines <n>]\n' +
      '       serve --truncate [<token>]\n\n' +
      '  Mint a worker-hosted preview URL for a VFS directory, broadcast it to\n' +
      "  all connected followers, and open it in the leader's browser.\n\n" +
      '  --entry      Override the entry file within the directory (default: index.html).\n' +
      '  --ttl <d>    Publish an immutable snapshot for up to 30d (units: m, h, d, w).\n' +
      '  --bridge     Make every visitor tab a live, leader-driveable target and\n' +
      '               auto-provision a webhook for its window.slicc.emit() beacons.\n' +
      '  --no-bridge  Force the live bridge OFF even when followers are Cherry-attached.\n' +
      '  --max-tabs   Cap concurrent bridge tab connections (default 20; with --bridge).\n' +
      '  --quiet      Suppress the single first-visit preview announcement.\n' +
      '  --stop <t>   Revoke a previously-minted preview token (closes bridge sockets,\n' +
      '               deletes the auto-provisioned webhook).\n' +
      '  --list       List active previews on this tray.\n' +
      '  --logs [t]   Show recent connects/disconnects without emitting a lick.\n' +
      '  --lines <n>  Limit --logs output to the newest n matching records.\n' +
      '  --truncate [t]  Clear lifecycle records and re-arm the announcement latch.\n' +
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
  logs?: true | string;
  truncate?: true | string;
  lines?: number;
  maxTabs?: number;
  quiet: boolean;
  ttlMs?: number;
  error?: string;
}

type ArgStepResult = { skip: number } | { error: string };

function isArgError(r: ArgStepResult): r is { error: string } {
  return 'error' in r;
}

function parseDiagnosticFlag(
  arg: string,
  nextArg: string | undefined,
  state: ParsedServeArgs
): ArgStepResult | undefined {
  if (arg === '--list') {
    state.list = true;
    return { skip: 0 };
  }
  if (arg === '--logs' || arg === '--truncate') {
    const field = arg === '--logs' ? 'logs' : 'truncate';
    if (nextArg && !nextArg.startsWith('-')) {
      state[field] = nextArg;
      return { skip: 1 };
    }
    state[field] = true;
    return { skip: 0 };
  }
  if (arg.startsWith('--logs=') || arg.startsWith('--truncate=')) {
    const field = arg.startsWith('--logs=') ? 'logs' : 'truncate';
    const value = arg.slice(arg.indexOf('=') + 1);
    if (!value) return { error: `serve: missing value for --${field}\n` };
    state[field] = value;
    return { skip: 0 };
  }
  if (arg === '--lines' || arg.startsWith('--lines=')) {
    const value = arg === '--lines' ? nextArg : arg.slice('--lines='.length);
    const lines = value === undefined ? Number.NaN : Number(value);
    if (!Number.isSafeInteger(lines) || lines <= 0) {
      return { error: 'serve: --lines must be a positive integer\n' };
    }
    state.lines = lines;
    return { skip: arg === '--lines' ? 1 : 0 };
  }
  return undefined;
}

function parseTtlFlag(
  arg: string,
  nextArg: string | undefined,
  state: ParsedServeArgs
): ArgStepResult | undefined {
  if (arg !== '--ttl' && !arg.startsWith('--ttl=')) return undefined;
  const value = arg === '--ttl' ? nextArg : arg.slice('--ttl='.length);
  if (!value) return { error: 'serve: missing value for --ttl\n' };
  const match = /^([1-9][0-9]*)([mhdw])$/.exec(value);
  if (!match) {
    return { error: 'serve: --ttl must be a positive whole duration (m, h, d, or w)\n' };
  }
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
  const ttlMs = Number(match[1]) * unitMs[match[2] as keyof typeof unitMs];
  if (!Number.isSafeInteger(ttlMs)) {
    return { error: 'serve: --ttl must be a positive whole duration (m, h, d, or w)\n' };
  }
  if (ttlMs > 30 * 86_400_000) {
    return {
      error:
        'serve: --ttl cannot exceed 30d; longer retention requires a Sliccy Deluxe De-Enshittification plan.\n',
    };
  }
  state.ttlMs = ttlMs;
  return { skip: arg === '--ttl' ? 1 : 0 };
}

function parseToggleFlag(arg: string, state: ParsedServeArgs): ArgStepResult | undefined {
  const field = {
    '--bridge': 'bridge',
    '--no-bridge': 'noBridge',
    '--project': 'project',
    '--quiet': 'quiet',
  }[arg] as 'bridge' | 'noBridge' | 'project' | 'quiet' | undefined;
  if (!field) return undefined;
  state[field] = true;
  return { skip: 0 };
}

function parseOneFlag(
  arg: string,
  nextArg: string | undefined,
  state: ParsedServeArgs
): ArgStepResult {
  const ttl = parseTtlFlag(arg, nextArg, state);
  if (ttl) return ttl;
  const toggle = parseToggleFlag(arg, state);
  if (toggle) return toggle;
  if (arg === '--entry') {
    if (!nextArg) return { error: 'serve: missing value for --entry\n' };
    state.entry = nextArg;
    return { skip: 1 };
  }
  if (arg.startsWith('--entry=')) {
    state.entry = arg.slice('--entry='.length);
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
  const diagnostic = parseDiagnosticFlag(arg, nextArg, state);
  if (diagnostic) return diagnostic;
  if (arg === '--max-tabs') {
    if (!nextArg) return { error: 'serve: missing value for --max-tabs\n' };
    const n = Number.parseInt(nextArg, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: 'serve: --max-tabs must be a positive integer\n' };
    }
    state.maxTabs = n;
    return { skip: 1 };
  }
  if (arg.startsWith('--max-tabs=')) {
    const n = Number.parseInt(arg.slice('--max-tabs='.length), 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: 'serve: --max-tabs must be a positive integer\n' };
    }
    state.maxTabs = n;
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
    quiet: false,
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

interface PreviewLogsOpts {
  previewToken?: string;
  lines?: number;
}

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
  let result: { revoked?: boolean; webhookId?: string };
  const inRealm = getPreviewOp();
  if (inRealm) {
    result = await inRealm({ type: 'stop', previewToken: token });
  } else {
    const rpc = getPanelRpcClient();
    if (!rpc) {
      return {
        stdout: '',
        stderr:
          'serve: no leader tray available. Enable multi-browser sync via `host enable` or the avatar popover.\n',
        exitCode: 1,
      };
    }
    result = await rpc.call('tray-revoke-preview', { previewToken: token });
  }
  if (!result.revoked) {
    return {
      stdout: '',
      stderr: `serve: preview token not found or already revoked\n`,
      exitCode: 1,
    };
  }
  // Delete the auto-provisioned `preview-bridge` webhook attached to the
  // record, if any (only bridged previews carry one). This runs in the realm
  // that owns the LickManager (the kernel worker / offscreen), which is why
  // cleanup lives on the `serve --stop` command rather than the page-side
  // `preview.revoked` handler — `getLickManagerSurface()` returns null on the
  // standalone page. Deletion is by id and best-effort: the preview is ALREADY
  // revoked worker-side, so a cleanup failure must not report the stop as failed
  // (a retry would then say "not found" and orphan the webhook). Surface it as a
  // warning on a success exit instead — never silently.
  if (result.webhookId) {
    const lickSurface = await getLickManagerSurface();
    if (!lickSurface) {
      return {
        stdout: `Preview revoked: ${token}\n`,
        stderr: `serve: preview revoked, but the preview-bridge webhook could not be cleaned up (lick manager unavailable). It is a live endpoint — delete it with \`webhook delete ${result.webhookId}\`.\n`,
        exitCode: 0,
      };
    }
    try {
      await lickSurface.deleteWebhook(result.webhookId);
    } catch (err) {
      return {
        stdout: `Preview revoked: ${token}\n`,
        stderr: `serve: preview revoked, but webhook cleanup failed: ${err instanceof Error ? err.message : String(err)}. Delete it with \`webhook delete ${result.webhookId}\`.\n`,
        exitCode: 0,
      };
    }
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
    return { stdout: formatPreviewList(previews), stderr: '', exitCode: 0 };
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
  return { stdout: formatPreviewList(previews), stderr: '', exitCode: 0 };
}

function formatPreviewList(
  previews: Array<{
    previewToken: string;
    url: string;
    servedRoot: string;
    createdAt: string;
    mode?: 'live' | 'persistent';
    expiresAt?: string;
  }>
): string {
  const lines = previews.map(
    (preview) =>
      `  ${preview.previewToken}  ${preview.mode ?? 'live'}  ${preview.expiresAt ?? '-'}  ${preview.url}  ${preview.servedRoot}  ${preview.createdAt}\n`
  );
  return `Active previews:\n  TOKEN  MODE  EXPIRES  URL  ROOT  CREATED\n${lines.join('')}`;
}

const EMPTY_PREVIEW_LOG_MESSAGE =
  'No preview lifecycle records. The recorder is leader-memory-only and resets on leader restart.\n';

function formatPreviewLifecycleRecord(record: PreviewLifecycleRecordResult): string {
  const disposition = record.announced ? 'announced' : 'suppressed';
  const preview = record.previewToken ?? '-';
  const detail =
    record.lifecycle === 'connected'
      ? `origin=${record.origin ?? '-'} userAgent=${record.userAgent ?? '-'}`
      : `reason=${record.reason ?? '-'}`;
  return `${record.timestamp}  ${record.lifecycle.padEnd(12)} ${disposition.padEnd(10)} preview=${preview} conn=${record.connId} ${detail}\n`;
}

async function previewLogs(opts: PreviewLogsOpts): Promise<ServeResult> {
  let lifecycleRecords: PreviewLifecycleRecordResult[];
  const inRealm = getPreviewOp();
  if (inRealm) {
    const result = await inRealm({ type: 'logs', previewToken: opts.previewToken });
    lifecycleRecords = result.lifecycleRecords ?? [];
  } else {
    const rpc = getPanelRpcClient();
    if (!rpc) {
      return {
        stdout: '',
        stderr:
          'serve --logs: no leader tray available. Enable multi-browser sync via `host enable` or the avatar popover.\n',
        exitCode: 1,
      };
    }
    const result = await rpc.call('tray-preview-logs', {
      previewToken: opts.previewToken,
    });
    lifecycleRecords = result.lifecycleRecords;
  }
  if (opts.lines !== undefined) lifecycleRecords = lifecycleRecords.slice(-opts.lines);
  if (lifecycleRecords.length === 0) {
    return { stdout: EMPTY_PREVIEW_LOG_MESSAGE, stderr: '', exitCode: 0 };
  }
  return {
    stdout: `Preview lifecycle records (oldest to newest):\n${lifecycleRecords.map(formatPreviewLifecycleRecord).join('')}`,
    stderr: '',
    exitCode: 0,
  };
}

async function truncatePreviewLogs(previewToken?: string): Promise<ServeResult> {
  let cleared: number;
  let rearmed: number;
  const inRealm = getPreviewOp();
  if (inRealm) {
    const result = await inRealm({ type: 'truncate', previewToken });
    cleared = result.cleared ?? 0;
    rearmed = result.rearmed ?? 0;
  } else {
    const rpc = getPanelRpcClient();
    if (!rpc) {
      return {
        stdout: '',
        stderr:
          'serve --truncate: no leader tray available. Enable multi-browser sync via `host enable` or the avatar popover.\n',
        exitCode: 1,
      };
    }
    const result = await rpc.call('tray-preview-truncate', { previewToken });
    cleared = result.cleared;
    rearmed = result.rearmed;
  }
  return {
    stdout: `Cleared ${cleared} preview lifecycle record${cleared === 1 ? '' : 's'}; re-armed ${rearmed} preview announcement${rearmed === 1 ? '' : 's'}.\n`,
    stderr: '',
    exitCode: 0,
  };
}

interface MintOpts {
  entryPath: string;
  servedRoot: string;
  bridge: boolean;
  noBridge: boolean;
  maxTabs?: number;
  quiet?: boolean;
  webhookId?: string;
  ttlMs?: number;
  snapshotFiles?: Array<{ path: string; content: Uint8Array; mime: string }>;
}

const MAX_SNAPSHOT_FILES = 1_000;
const MAX_SNAPSHOT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 50 * 1024 * 1024;

async function collectSnapshotFiles(
  vfs: VirtualFS,
  servedRoot: string
): Promise<Array<{ path: string; content: Uint8Array; mime: string }>> {
  const files: Array<{ path: string; content: Uint8Array; mime: string }> = [];
  let totalBytes = 0;
  for await (const absolutePath of vfs.walk(servedRoot)) {
    if (files.length >= MAX_SNAPSHOT_FILES) {
      throw new Error('persistent preview exceeds 1000 file limit');
    }
    const raw = await vfs.readFile(absolutePath, { encoding: 'binary' });
    const content = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    const relativePath = absolutePath.slice(servedRoot === '/' ? 1 : servedRoot.length + 1);
    if (content.byteLength > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error(`preview file exceeds 25 MiB limit: ${relativePath}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new Error('persistent preview exceeds 50 MiB total limit');
    }
    files.push({ path: relativePath, content, mime: detectMimeType(relativePath) });
  }
  return files;
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
  if (opts.ttlMs !== undefined) {
    // A 50 MiB snapshot takes about seven minutes at 1 Mbps, and the page-side
    // handler does not resolve until every R2 upload and finalization completes.
    return rpc.call('tray-open-preview', opts, { timeoutMs: PERSISTENT_PREVIEW_RPC_TIMEOUT_MS });
  }
  return rpc.call('tray-open-preview', opts);
}

async function openPreviewTab(url: string, browserAPI?: BrowserAPI): Promise<string | undefined> {
  if (browserAPI) {
    return browserAPI.createPage(url);
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return undefined;
}

/**
 * Provision the `preview-bridge` webhook before minting a bridged preview, so
 * the driveable preview's `window.slicc.emit()` beacons arrive as licks on the
 * leader. The returned webhookId rides to the DO record; `--stop` deletes it.
 * No-op (returns `{ ok: true }` with no webhookId) when the preview is not
 * bridged. Extracted from `createServeCommand` to keep cognitive complexity low.
 */
async function provisionBridgeWebhook(
  effectiveBridge: boolean,
  deprecationNotice: string
): Promise<{ ok: true; webhookId?: string } | { ok: false; result: ServeResult }> {
  if (!effectiveBridge) return { ok: true };
  const lickSurface = await getLickManagerSurface();
  if (!lickSurface) {
    return {
      ok: false,
      result: {
        stdout: '',
        stderr: `${deprecationNotice}serve: --bridge requires an active lick manager\n`,
        exitCode: 1,
      },
    };
  }
  try {
    const webhook = await lickSurface.createWebhook('preview-bridge');
    return { ok: true, webhookId: webhook.id };
  } catch (err) {
    return {
      ok: false,
      result: {
        stdout: '',
        stderr: `${deprecationNotice}serve: webhook creation failed: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      },
    };
  }
}

/** Mint the preview, opening the leader tab; clean up an orphaned webhook on failure. */
async function executeMint(
  parsed: ParsedServeArgs,
  fullDirectory: string,
  entryPath: string,
  webhookId: string | undefined,
  deprecationNotice: string,
  snapshotFiles: Array<{ path: string; content: Uint8Array; mime: string }> | undefined,
  browserAPI?: BrowserAPI
): Promise<ServeResult> {
  let result: MintPreviewResult;
  try {
    result = await mintPreview({
      entryPath,
      servedRoot: fullDirectory,
      bridge: parsed.bridge,
      noBridge: parsed.ttlMs !== undefined || parsed.noBridge,
      maxTabs: parsed.maxTabs,
      quiet: parsed.quiet,
      webhookId,
      ttlMs: parsed.ttlMs,
      snapshotFiles,
    });
  } catch (err) {
    // Best-effort orphan cleanup — must NOT mask the original mint failure
    // (that's the actionable error the user needs), so swallow any cleanup throw.
    if (webhookId) {
      const lickSurface = await getLickManagerSurface();
      if (lickSurface) {
        await lickSurface.deleteWebhook(webhookId).catch(() => {
          /* best-effort; surface the mint error below */
        });
      }
    }
    return {
      stdout: '',
      stderr: `${deprecationNotice}serve: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  const targetId = await openPreviewTab(result.url, browserAPI);

  const followerLabel = `${result.pushed} follower${result.pushed === 1 ? '' : 's'}`;
  const targetIdSuffix = targetId ? ` (targetId: ${targetId})` : '';
  return {
    stdout: `Preview URL: ${result.url}${targetIdSuffix}\nPushed to ${followerLabel}\n`,
    stderr: deprecationNotice,
    exitCode: 0,
  };
}

async function handleServeOperation(parsed: ParsedServeArgs): Promise<ServeResult | undefined> {
  if (parsed.stop) {
    const stopToken = parsed.stop;
    return withServeError(() => stopPreview(stopToken));
  }
  if (parsed.list) return withServeError(() => listPreviews());
  if (parsed.logs && parsed.truncate) {
    return {
      stdout: '',
      stderr: 'serve: --logs and --truncate are mutually exclusive\n',
      exitCode: 1,
    };
  }
  if (parsed.lines !== undefined && !parsed.logs) {
    return { stdout: '', stderr: 'serve: --lines requires --logs\n', exitCode: 1 };
  }
  if (parsed.logs) {
    const previewToken = typeof parsed.logs === 'string' ? parsed.logs : undefined;
    return withServeError(() => previewLogs({ previewToken, lines: parsed.lines }));
  }
  if (parsed.truncate) {
    const previewToken = typeof parsed.truncate === 'string' ? parsed.truncate : undefined;
    return withServeError(() => truncatePreviewLogs(previewToken));
  }
  return undefined;
}

function validatePersistentOptions(parsed: ParsedServeArgs): ServeResult | undefined {
  if (parsed.ttlMs !== undefined && parsed.bridge) {
    return { stdout: '', stderr: 'serve: --ttl cannot be combined with --bridge\n', exitCode: 1 };
  }
  if (parsed.ttlMs !== undefined && parsed.maxTabs !== undefined) {
    return { stdout: '', stderr: 'serve: --ttl cannot be combined with --max-tabs\n', exitCode: 1 };
  }
  return undefined;
}

async function snapshotForMint(
  parsed: ParsedServeArgs,
  vfs: VirtualFS | undefined,
  fullDirectory: string
): Promise<Array<{ path: string; content: Uint8Array; mime: string }> | undefined> {
  if (parsed.ttlMs === undefined) return undefined;
  if (!vfs) throw new Error('persistent snapshot filesystem unavailable');
  return collectSnapshotFiles(vfs, fullDirectory);
}

async function handleServeCommand(
  args: string[],
  ctx: import('just-bash').CommandContext,
  browserAPI?: BrowserAPI,
  vfs?: VirtualFS
): Promise<ServeResult> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return serveHelp();
  }

  const parsed = parseUnifiedArgs(args);
  if (parsed.error) {
    return { stdout: '', stderr: parsed.error, exitCode: 1 };
  }

  const operation = await handleServeOperation(parsed);
  if (operation) return operation;

  if (!parsed.directory) {
    return serveHelp();
  }
  const persistentError = validatePersistentOptions(parsed);
  if (persistentError) return persistentError;

  const validation = await validateServeTarget(parsed.directory, parsed.entry, ctx.fs, ctx.cwd);
  if (isValidationError(validation)) {
    return validation;
  }
  const { fullDirectory, entryPath } = validation;

  let snapshotFiles: Array<{ path: string; content: Uint8Array; mime: string }> | undefined;
  try {
    snapshotFiles = await snapshotForMint(parsed, vfs, fullDirectory);
  } catch (err) {
    return {
      stdout: '',
      stderr: `serve: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  const deprecationNotice = parsed.project
    ? 'serve: --project is obsolete; ignored (root-absolute paths work natively under unified preview)\n'
    : '';

  // Effective bridge = explicit --bridge, unless --no-bridge overrides.
  // (Cherry-follower default-on is applied at the mint site, not here.)
  const effectiveBridge = !parsed.noBridge && parsed.bridge;
  const provision = await provisionBridgeWebhook(effectiveBridge, deprecationNotice);
  if (!provision.ok) return provision.result;

  return executeMint(
    parsed,
    fullDirectory,
    entryPath,
    provision.webhookId,
    deprecationNotice,
    snapshotFiles,
    browserAPI
  );
}

export function createServeCommand(browserAPI?: BrowserAPI, vfs?: VirtualFS): Command {
  return defineCommand('serve', (args, ctx) => handleServeCommand(args, ctx, browserAPI, vfs));
}
