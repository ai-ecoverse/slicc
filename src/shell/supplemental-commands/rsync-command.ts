/**
 * `rsync` shell command — sync files between local VFS and a remote tray runtime.
 *
 * Usage:
 *   rsync <local-path> <runtime-id>:<remote-path>     # push local → remote
 *   rsync <runtime-id>:<remote-path> <local-path>     # pull remote → local
 *
 * Flags:
 *   --dry-run    Show what would be transferred without actually doing it
 *   --delete     Delete files in dest that don't exist in source
 *   --verbose    Show detailed per-file output
 *   --help, -h   Show usage
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import type { TrayFsRequest, TrayFsResponse, TrayFsResponseData } from '../../scoops/tray-sync-protocol.js';
import { computeRsyncDiff, type RsyncEntry } from './rsync-diff.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SendFsRequestFn = (
  targetRuntimeId: string,
  request: TrayFsRequest,
) => Promise<TrayFsResponse[]>;

export interface RsyncCommandOptions {
  fs?: VirtualFS;
  getSendFsRequest?: () => SendFsRequestFn | null;
}

// ---------------------------------------------------------------------------
// Module-level callback (same pattern as host-command.ts)
// ---------------------------------------------------------------------------

let sendFsRequestGetter: (() => SendFsRequestFn | null) | null = null;

export function setRsyncSendFsRequest(getter: (() => SendFsRequestFn | null) | null): void {
  sendFsRequestGetter = getter;
}

function getSendFsRequest(): SendFsRequestFn | null {
  return sendFsRequestGetter?.() ?? null;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedRsyncArgs {
  direction: 'push' | 'pull';
  localPath: string;
  remotePath: string;
  runtimeId: string;
  dryRun: boolean;
  delete: boolean;
  verbose: boolean;
}

/**
 * Parse rsync command arguments.
 *
 * Expects exactly two positional args: source and dest.
 * One must contain a colon `:` to identify the remote side.
 */
export function parseRsyncArgs(args: string[]): ParsedRsyncArgs | { error: string } {
  const flags = { dryRun: false, delete: false, verbose: false };
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === '--dry-run' || arg === '-n') {
      flags.dryRun = true;
    } else if (arg === '--delete') {
      flags.delete = true;
    } else if (arg === '--verbose' || arg === '-v') {
      flags.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      return { error: '__help__' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    return { error: 'Expected exactly 2 arguments: <source> <dest>' };
  }

  const [src, dst] = positional;
  const srcRemote = parseRemoteSpec(src);
  const dstRemote = parseRemoteSpec(dst);

  if (srcRemote && dstRemote) {
    return { error: 'Cannot sync between two remote paths — one side must be local' };
  }

  if (!srcRemote && !dstRemote) {
    return { error: 'One argument must be a remote path (runtime-id:/path)' };
  }

  if (dstRemote) {
    // push: local → remote
    return {
      direction: 'push',
      localPath: src,
      remotePath: dstRemote.path,
      runtimeId: dstRemote.runtimeId,
      ...flags,
    };
  }

  // pull: remote → local
  return {
    direction: 'pull',
    localPath: dst,
    remotePath: srcRemote!.path,
    runtimeId: srcRemote!.runtimeId,
    ...flags,
  };
}

function parseRemoteSpec(spec: string): { runtimeId: string; path: string } | null {
  const idx = spec.indexOf(':');
  if (idx <= 0) return null;
  // Avoid matching Windows-style drive letters (single char before colon)
  // and absolute paths like /foo — the colon must be preceded by an identifier
  const runtimeId = spec.slice(0, idx);
  const path = spec.slice(idx + 1);
  if (!path.startsWith('/')) return null;
  return { runtimeId, path };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function rsyncHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `rsync — sync files between local VFS and a remote tray runtime

Usage:
  rsync [flags] <local-path> <runtime-id>:<remote-path>   # push
  rsync [flags] <runtime-id>:<remote-path> <local-path>   # pull

Flags:
  --dry-run, -n   Show what would be transferred without doing it
  --delete        Delete files in dest not present in source
  --verbose, -v   Show detailed per-file output
  --help, -h      Show this help

Examples:
  rsync /workspace follower-abc123:/workspace
  rsync --delete /shared leader:/shared
  rsync follower-abc123:/workspace/project /workspace/project
`,
    stderr: '',
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Local VFS helpers
// ---------------------------------------------------------------------------

async function walkLocalEntries(vfs: VirtualFS, basePath: string): Promise<RsyncEntry[]> {
  if (!await vfs.exists(basePath)) return [];
  const entries: RsyncEntry[] = [];
  for await (const filePath of vfs.walk(basePath)) {
    const relPath = filePath.slice(basePath.length).replace(/^\//, '');
    if (!relPath) continue;
    const stat = await vfs.stat(filePath);
    entries.push({ path: relPath, size: stat.size, mtimeMs: stat.mtime });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Remote VFS helpers
// ---------------------------------------------------------------------------

async function walkRemoteEntries(
  sendFsReq: SendFsRequestFn,
  runtimeId: string,
  basePath: string,
): Promise<RsyncEntry[]> {
  // First get all file paths via walk
  const walkResponses = await sendFsReq(runtimeId, { op: 'walk', path: basePath });
  const walkResp = walkResponses[0];
  if (!walkResp.ok) {
    // If path doesn't exist, return empty — we'll create it during sync
    if (walkResp.code === 'ENOENT') return [];
    throw new Error(`Remote walk failed: ${walkResp.error}`);
  }
  if (walkResp.data.type !== 'paths') {
    throw new Error('Unexpected walk response type');
  }

  const filePaths = walkResp.data.paths;
  const entries: RsyncEntry[] = [];

  // Stat each file to get size and mtime
  for (const filePath of filePaths) {
    const relPath = filePath.slice(basePath.length).replace(/^\//, '');
    if (!relPath) continue;
    const statResponses = await sendFsReq(runtimeId, { op: 'stat', path: filePath });
    const statResp = statResponses[0];
    if (statResp.ok && statResp.data.type === 'stat') {
      entries.push({
        path: relPath,
        size: statResp.data.stat.size,
        mtimeMs: statResp.data.stat.mtime,
      });
    }
  }

  return entries;
}

async function readRemoteFile(
  sendFsReq: SendFsRequestFn,
  runtimeId: string,
  path: string,
): Promise<string> {
  const responses = await sendFsReq(runtimeId, { op: 'readFile', path, encoding: 'binary' });
  // Reassemble chunks
  let content = '';
  for (const resp of responses) {
    if (!resp.ok) throw new Error(`Remote read failed: ${resp.error}`);
    if (resp.data.type === 'file') {
      content += resp.data.content;
    }
  }
  return content;
}

async function ensureRemoteDir(
  sendFsReq: SendFsRequestFn,
  runtimeId: string,
  path: string,
): Promise<void> {
  const responses = await sendFsReq(runtimeId, { op: 'mkdir', path, recursive: true });
  if (!responses[0].ok) {
    throw new Error(`Remote mkdir failed: ${responses[0].error}`);
  }
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Sync execution
// ---------------------------------------------------------------------------

async function executePush(
  vfs: VirtualFS,
  sendFsReq: SendFsRequestFn,
  parsed: ParsedRsyncArgs,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const lines: string[] = [];
  const { localPath, remotePath, runtimeId, verbose, dryRun } = parsed;

  // Gather entries
  const sourceEntries = await walkLocalEntries(vfs, localPath);
  const destEntries = await walkRemoteEntries(sendFsReq, runtimeId, remotePath);

  const diff = computeRsyncDiff(sourceEntries, destEntries, { delete: parsed.delete });

  if (verbose || dryRun) {
    for (const f of diff.toAdd) lines.push(`+ ${f}`);
    for (const f of diff.toUpdate) lines.push(`~ ${f}`);
    for (const f of diff.toDelete) lines.push(`- ${f}`);
    if (verbose) {
      for (const f of diff.toSkip) lines.push(`  ${f} (up to date)`);
    }
  }

  const totalOps = diff.toAdd.length + diff.toUpdate.length + diff.toDelete.length;

  if (dryRun) {
    lines.push(`\n(dry run) ${totalOps} file(s) would be transferred, ${diff.toSkip.length} up to date`);
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  // Transfer files (add + update)
  for (const relPath of [...diff.toAdd, ...diff.toUpdate]) {
    const srcPath = localPath + '/' + relPath;
    const dstPath = remotePath + '/' + relPath;

    // Ensure parent dir on remote
    await ensureRemoteDir(sendFsReq, runtimeId, dirname(dstPath));

    // Read local file as binary (base64)
    const data = await vfs.readFile(srcPath, { encoding: 'binary' }) as Uint8Array;
    const b64 = uint8ToBase64(data);
    const writeResponses = await sendFsReq(runtimeId, {
      op: 'writeFile',
      path: dstPath,
      content: b64,
      encoding: 'base64',
    });
    if (!writeResponses[0].ok) {
      return {
        stdout: lines.join('\n') + '\n',
        stderr: `Error writing ${dstPath}: ${writeResponses[0].error}\n`,
        exitCode: 1,
      };
    }
  }

  // Delete remote files not in source
  for (const relPath of diff.toDelete) {
    const dstPath = remotePath + '/' + relPath;
    const rmResponses = await sendFsReq(runtimeId, { op: 'rm', path: dstPath });
    if (!rmResponses[0].ok) {
      return {
        stdout: lines.join('\n') + '\n',
        stderr: `Error deleting ${dstPath}: ${rmResponses[0].error}\n`,
        exitCode: 1,
      };
    }
  }

  lines.push(`${totalOps} file(s) transferred, ${diff.toSkip.length} up to date`);
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

async function executePull(
  vfs: VirtualFS,
  sendFsReq: SendFsRequestFn,
  parsed: ParsedRsyncArgs,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const lines: string[] = [];
  const { localPath, remotePath, runtimeId, verbose, dryRun } = parsed;

  // Gather entries
  const sourceEntries = await walkRemoteEntries(sendFsReq, runtimeId, remotePath);
  const destEntries = await walkLocalEntries(vfs, localPath);

  const diff = computeRsyncDiff(sourceEntries, destEntries, { delete: parsed.delete });

  if (verbose || dryRun) {
    for (const f of diff.toAdd) lines.push(`+ ${f}`);
    for (const f of diff.toUpdate) lines.push(`~ ${f}`);
    for (const f of diff.toDelete) lines.push(`- ${f}`);
    if (verbose) {
      for (const f of diff.toSkip) lines.push(`  ${f} (up to date)`);
    }
  }

  const totalOps = diff.toAdd.length + diff.toUpdate.length + diff.toDelete.length;

  if (dryRun) {
    lines.push(`\n(dry run) ${totalOps} file(s) would be transferred, ${diff.toSkip.length} up to date`);
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  // Transfer files (add + update) from remote → local
  for (const relPath of [...diff.toAdd, ...diff.toUpdate]) {
    const srcPath = remotePath + '/' + relPath;
    const dstPath = localPath + '/' + relPath;

    // Ensure parent dir locally
    const parentDir = dirname(dstPath);
    if (!await vfs.exists(parentDir)) {
      await vfs.mkdir(parentDir, { recursive: true });
    }

    // Read remote file (base64)
    const b64Content = await readRemoteFile(sendFsReq, runtimeId, srcPath);
    const data = base64ToUint8(b64Content);
    await vfs.writeFile(dstPath, data);
  }

  // Delete local files not in source
  for (const relPath of diff.toDelete) {
    const dstPath = localPath + '/' + relPath;
    await vfs.rm(dstPath);
  }

  lines.push(`${totalOps} file(s) transferred, ${diff.toSkip.length} up to date`);
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Base64 helpers (duplicated from tray-fs-handler.ts for independence)
// ---------------------------------------------------------------------------

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createRsyncCommand(options: RsyncCommandOptions = {}): Command {
  const fs = options.fs;
  const getFn = options.getSendFsRequest ?? getSendFsRequest;

  return defineCommand('rsync', async (args) => {
    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
      return rsyncHelp();
    }

    if (!fs) {
      return { stdout: '', stderr: 'rsync: no filesystem available\n', exitCode: 1 };
    }

    const sendFsReq = getFn();
    if (!sendFsReq) {
      return {
        stdout: '',
        stderr: 'rsync: not connected to a tray — rsync requires a tray connection\n',
        exitCode: 1,
      };
    }

    const parsed = parseRsyncArgs(args);
    if ('error' in parsed) {
      if (parsed.error === '__help__') return rsyncHelp();
      return { stdout: '', stderr: `rsync: ${parsed.error}\n`, exitCode: 1 };
    }

    try {
      if (parsed.direction === 'push') {
        return await executePush(fs, sendFsReq, parsed);
      } else {
        return await executePull(fs, sendFsReq, parsed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `rsync: ${msg}\n`, exitCode: 1 };
    }
  });
}
