import type { FsStat } from 'just-bash';
import { resolveSyncFsToken, type SyncFsTokenEntry } from './sync-fs-token-registry.js';

export type SyncFsOp =
  | 'read'
  | 'write'
  | 'exists'
  | 'stat'
  | 'lstat'
  | 'readdir'
  | 'mkdir'
  | 'rm'
  | 'rename'
  | 'unlink'
  | 'rmdir'
  | 'symlink'
  | 'readlink'
  | 'chmod'
  | 'utimes';

export interface SyncFsRequest {
  token: string;
  op: SyncFsOp;
  path: string;

  body?: Uint8Array;

  arg2?: string;

  mode?: number;

  atimeMs?: number;
  mtimeMs?: number;
}

export type SyncFsResult =
  | { ok: true; kind: 'bytes'; bytes: Uint8Array }
  | { ok: true; kind: 'json'; json: unknown }
  | { ok: true; kind: 'void' }
  | { ok: false; errno: string; message: string };

export function toErrno(err: unknown): SyncFsResult {
  const message = err instanceof Error ? err.message : String(err);

  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return { ok: false, errno: code, message };
  }
  return { ok: false, errno: 'EIO', message };
}

export async function dispatchSyncFs(req: SyncFsRequest): Promise<SyncFsResult> {
  const entry = resolveSyncFsToken(req.token);
  if (!entry) {
    return { ok: false, errno: 'EACCES', message: 'sync-fs: unknown or revoked token' };
  }
  const { fs, cwd } = entry;
  try {
    const resolved = fs.resolvePath(cwd, req.path);
    switch (req.op) {
      case 'read':
        return { ok: true, kind: 'bytes', bytes: await fs.readFileBuffer(resolved) };
      case 'write':
        await fs.writeFile(resolved, req.body ?? new Uint8Array(0));
        return { ok: true, kind: 'void' };
      case 'exists':
        return { ok: true, kind: 'json', json: await fs.exists(resolved) };
      case 'stat':
        return { ok: true, kind: 'json', json: statJson(await fs.stat(resolved)) };
      case 'lstat':
        return { ok: true, kind: 'json', json: statJson(await fs.lstat(resolved)) };
      case 'readdir':
        return { ok: true, kind: 'json', json: await fs.readdir(resolved) };
      case 'mkdir':
        await fs.mkdir(resolved, { recursive: true });
        return { ok: true, kind: 'void' };
      case 'rm':
        await fs.rm(resolved, { recursive: true });
        return { ok: true, kind: 'void' };
      case 'rename': {
        const dest = fs.resolvePath(cwd, req.arg2 ?? '');
        const { renameViaFs } = await import('./rename-via-fs.js');
        await renameViaFs(fs, resolved, dest);
        return { ok: true, kind: 'void' };
      }
      default:
        return await dispatchPosixOp(fs, resolved, req);
    }
  } catch (err) {
    return toErrno(err);
  }
}

export interface SyncFsStatJson {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
}

function statJson(s: FsStat): SyncFsStatJson {
  return {
    isDirectory: s.isDirectory,
    isFile: s.isFile,
    isSymbolicLink: s.isSymbolicLink ?? false,
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtime instanceof Date ? s.mtime.getTime() : 0,
  };
}

function posixError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

async function dispatchPosixOp(
  fs: SyncFsTokenEntry['fs'],
  resolved: string,
  req: SyncFsRequest
): Promise<SyncFsResult> {
  switch (req.op) {
    case 'unlink': {
      if ((await fs.lstat(resolved)).isDirectory) throw posixError('EISDIR', resolved);
      await fs.rm(resolved);
      return { ok: true, kind: 'void' };
    }
    case 'rmdir': {
      if (!(await fs.lstat(resolved)).isDirectory) throw posixError('ENOTDIR', resolved);
      if ((await fs.readdir(resolved)).length > 0) throw posixError('ENOTEMPTY', resolved);
      await fs.rm(resolved, { recursive: true });
      return { ok: true, kind: 'void' };
    }
    case 'symlink':
      if (!req.arg2) throw posixError('EINVAL', resolved);
      await fs.symlink(req.arg2, resolved);
      return { ok: true, kind: 'void' };
    case 'readlink':
      return { ok: true, kind: 'json', json: await fs.readlink(resolved) };
    case 'chmod':
      if (typeof req.mode !== 'number') throw posixError('EINVAL', resolved);
      await fs.chmod(resolved, req.mode);
      return { ok: true, kind: 'void' };
    case 'utimes':
      if (typeof req.atimeMs !== 'number' || typeof req.mtimeMs !== 'number') {
        throw posixError('EINVAL', resolved);
      }
      await fs.utimes(resolved, new Date(req.atimeMs), new Date(req.mtimeMs));
      return { ok: true, kind: 'void' };
    default:
      return { ok: false, errno: 'EINVAL', message: `sync-fs: unknown op '${req.op as string}'` };
  }
}
