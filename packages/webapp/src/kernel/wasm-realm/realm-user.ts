import type { ProcessFs } from './kernel-streams.js';

export const REALM_UID = 1000;
export const REALM_GID = 1000;

export function ownByRealmUser(Fs: ProcessFs): void {
  const { stat, fstat } = Fs;
  const owned = (attr: object): object => ({ ...attr, uid: REALM_UID, gid: REALM_GID });
  if (typeof stat === 'function') {
    Fs.stat = (path, dontFollow) => owned(stat.call(Fs, path, dontFollow));
  }
  if (typeof fstat === 'function') Fs.fstat = (fd) => owned(fstat.call(Fs, fd));
}
