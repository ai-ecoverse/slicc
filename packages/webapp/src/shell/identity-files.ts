/**
 * `/etc/passwd` and `/etc/group` for SLICC's one user: uid/gid 1000 named
 * `user`, home `/home/user`, shell `/bin/bash`, the identity the shell exports
 * and the wasm realm reports (`realm-user.ts`). The shell's file system
 * answers them when the VFS has none, so `getpwuid` / `getgrgid` know the
 * account: GNU screen refuses to start without it, and ssh, Python's `pwd` /
 * `getpass` and git's author fallback read it too. A file the user writes at
 * either path takes precedence.
 */
import { DEFAULT_HOME_DIR } from './home-dir.js';

const FILES = new Map<string, string>([
  [
    '/etc/passwd',
    [
      'root:x:0:0:root:/root:/bin/bash',
      `user:x:1000:1000:SLICC user:${DEFAULT_HOME_DIR}:/bin/bash`,
      'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
      '',
    ].join('\n'),
  ],
  ['/etc/group', ['root:x:0:', 'user:x:1000:', 'nogroup:x:65534:', ''].join('\n')],
]);

/** The synthetic content of `path` (normalized), or undefined when it is none of them. */
export function identityFile(path: string): Uint8Array | undefined {
  const text = FILES.get(path);
  return text === undefined ? undefined : new TextEncoder().encode(text);
}

/** The synthetic files' names in directory `dir` (normalized): `/etc` lists them. */
export function identityFileNames(dir: string): string[] {
  return dir === '/etc' ? ['group', 'passwd'] : [];
}

/** Whether `err` says the path does not exist (where a synthetic file stands in). */
export function isMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}
