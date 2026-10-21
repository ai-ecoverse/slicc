/**
 * OPFS writer for the version 2 (directory) profile export: entries go to
 * `<OPFS root>/slicc-v6-upgrade/<exportId>/<entry path>`, which is
 * `/slicc-v6-upgrade/<exportId>/` in seven's kernel on the same origin.
 * Outside `slicc-fs/`, so writing it never touches six's VFS or its index.
 */

import { PROFILE_DIRECTORY_ROOT } from '@slicc/shared-ts';
import type { ProfileDirectoryWriter } from './profile-export.js';

/** The OPFS directory name of {@link PROFILE_DIRECTORY_ROOT}. */
export const PROFILE_DIRECTORY_NAME = PROFILE_DIRECTORY_ROOT.replace(/^\/+|\/+$/g, '');

/** Open (creating) `<root>/slicc-v6-upgrade/<exportId>/` and return a writer into it. */
export async function openOpfsProfileDirectory(
  root: FileSystemDirectoryHandle,
  exportId: string
): Promise<ProfileDirectoryWriter> {
  const exports = await root.getDirectoryHandle(PROFILE_DIRECTORY_NAME, { create: true });
  const base = await exports.getDirectoryHandle(exportId, { create: true });
  const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>([['', Promise.resolve(base)]]);
  const dirFor = (rel: string): Promise<FileSystemDirectoryHandle> => {
    let dir = dirs.get(rel);
    if (!dir) {
      const cut = rel.lastIndexOf('/');
      const parent = dirFor(cut < 0 ? '' : rel.slice(0, cut));
      dir = parent.then((p) => p.getDirectoryHandle(rel.slice(cut + 1), { create: true }));
      dirs.set(rel, dir);
    }
    return dir;
  };
  return {
    async remove() {
      await exports.removeEntry(exportId, { recursive: true });
    },
    async writeFile(path, bytes) {
      const cut = path.lastIndexOf('/');
      const dir = await dirFor(cut < 0 ? '' : path.slice(0, cut));
      const file = await dir.getFileHandle(path.slice(cut + 1), { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
      } catch (err) {
        await writable.abort().catch(() => {});
        throw err;
      }
      await writable.close();
    },
  };
}
