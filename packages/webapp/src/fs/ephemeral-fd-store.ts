import { normalizePath } from './path-utils.js';
import type { FileContent, ReadFileOptions, Stats } from './types.js';
import { FsError } from './types.js';
import { isEphemeralFdPath } from './virtual-device-paths.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

interface FdEntry {
  bytes: Uint8Array;
  mtime: number;
  ctime: number;
}

export class EphemeralFdStore {
  private entries = new Map<string, FdEntry>();

  static handles(path: string): boolean {
    return isEphemeralFdPath(normalizePath(path));
  }

  has(path: string): boolean {
    return this.entries.has(normalizePath(path));
  }

  write(path: string, content: FileContent): void {
    const key = normalizePath(path);
    const bytes = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
    const now = Date.now();
    const existing = this.entries.get(key);
    this.entries.set(key, { bytes, mtime: now, ctime: existing?.ctime ?? now });
  }

  append(path: string, content: FileContent): void {
    const existing = this.entries.get(normalizePath(path))?.bytes ?? new Uint8Array(0);
    const added = typeof content === 'string' ? encoder.encode(content) : content;
    const bytes = new Uint8Array(existing.length + added.length);
    bytes.set(existing);
    bytes.set(added, existing.length);
    this.write(path, bytes);
  }

  read(path: string, options?: ReadFileOptions): FileContent {
    const entry = this.require(path);
    if ((options?.encoding ?? 'utf-8') === 'utf-8') return decoder.decode(entry.bytes);
    return new Uint8Array(entry.bytes);
  }

  readText(path: string): string {
    return decoder.decode(this.require(path).bytes);
  }

  stat(path: string): Stats {
    const entry = this.require(path);
    return { type: 'file', size: entry.bytes.length, mtime: entry.mtime, ctime: entry.ctime };
  }

  remove(path: string): boolean {
    return this.entries.delete(normalizePath(path));
  }

  private require(path: string): FdEntry {
    const key = normalizePath(path);
    const entry = this.entries.get(key);
    if (!entry) throw new FsError('ENOENT', 'no such file or directory', key);
    return entry;
  }
}
