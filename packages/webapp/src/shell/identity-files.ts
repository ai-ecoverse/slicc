/**
 * `/etc/passwd` and `/etc/group` for SLICC's one user: uid/gid 1000 (what
 * the wasm realm reports, `realm-user.ts`) named as the shell's `$USER`,
 * home `$HOME`, shell `/bin/bash`. The shell's file system answers them
 * when the VFS has none, so `getpwuid` / `getgrgid` know the account: GNU
 * screen refuses to start without it, and ssh, Python's `pwd` / `getpass`
 * and git's author fallback read it too. A file the user writes at either
 * path takes precedence.
 */
import { DEFAULT_HOME_DIR } from './home-dir.js';

/** Whose account uid 1000 is: the shell's `$USER` and `$HOME`. */
export interface ShellIdentity {
  user: string;
  home: string;
}

export const DEFAULT_IDENTITY: ShellIdentity = { user: 'user', home: DEFAULT_HOME_DIR };

/** Names the other entries take, and what a passwd field cannot hold. */
const RESERVED = new Set(['root', 'nobody', 'nogroup']);
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** `identity`, with the default standing in for a name or home a passwd line cannot carry. */
function usable(identity: ShellIdentity): ShellIdentity {
  const user =
    NAME.test(identity.user) && !RESERVED.has(identity.user)
      ? identity.user
      : DEFAULT_IDENTITY.user;
  const home =
    identity.home.startsWith('/') && !/[:\n]/.test(identity.home)
      ? identity.home
      : DEFAULT_IDENTITY.home;
  return { user, home };
}

function contents(path: string, identity: ShellIdentity): string | undefined {
  const { user, home } = usable(identity);
  if (path === '/etc/passwd') {
    return [
      'root:x:0:0:root:/root:/bin/bash',
      `${user}:x:1000:1000:SLICC user:${home}:/bin/bash`,
      'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
      '',
    ].join('\n');
  }
  if (path === '/etc/group')
    return ['root:x:0:', `${user}:x:1000:`, 'nogroup:x:65534:', ''].join('\n');
  return undefined;
}

/** The synthetic content of `path` (normalized) for `identity`, or undefined when it is none of them. */
export function identityFile(
  path: string,
  identity: ShellIdentity = DEFAULT_IDENTITY
): Uint8Array | undefined {
  const text = contents(path, identity);
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
