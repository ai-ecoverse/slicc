/**
 * `readDir` over a path-keyed in-memory file map, for the hand-rolled VFS
 * fakes the sessions-index writers run against: a corrupt index is rebuilt
 * by listing the archives (`readSessionsIndexForWrite`), so every fake an
 * index writer touches has to be able to list a directory. Lists the direct
 * children of `dir`; a directory with nothing under it is ENOENT.
 */
import { FsError } from '../../src/fs/types.js';

export function mapReadDir(
  files: ReadonlyMap<string, unknown>
): (dir: string) => Promise<Array<{ name: string; type: string }>> {
  return async (dir) => {
    const prefix = `${dir.replace(/\/+$/, '')}/`;
    const children = new Map<string, string>();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      children.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'directory');
    }
    if (children.size === 0) throw new FsError('ENOENT', `missing ${dir}`, dir);
    return [...children].map(([name, type]) => ({ name, type }));
  };
}
