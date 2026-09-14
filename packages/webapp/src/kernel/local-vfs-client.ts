import type { ReadDirOptions } from '../fs/mount/backend.js';
import type { DirEntry, FsChangeEvent, ReadFileOptions, Stats } from '../fs/types.js';

export interface LocalVfsClient {
  readDir(path: string, opts?: ReadDirOptions): Promise<DirEntry[]>;

  readFile(path: string, options?: ReadFileOptions): Promise<string | Uint8Array>;

  readFileRange?(path: string, start: number, end: number): Promise<Uint8Array>;

  stat(path: string): Promise<Stats>;

  watch?(
    basePaths: readonly string[],
    callback: (events: FsChangeEvent[]) => void
  ): Promise<() => void>;
}

export function createLocalVfsClient(source: LocalVfsClient): LocalVfsClient {
  const watch = source.watch?.bind(source);
  const readFileRange = source.readFileRange?.bind(source);
  return {
    readDir: (path, opts) =>
      opts === undefined ? source.readDir(path) : source.readDir(path, opts),
    readFile: (path, options) => source.readFile(path, options),
    stat: (path) => source.stat(path),

    ...(watch ? { watch } : {}),
    ...(readFileRange ? { readFileRange } : {}),
  };
}
