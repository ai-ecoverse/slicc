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
