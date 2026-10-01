import { DEFAULT_HOME_DIR } from './home-dir.js';

export interface ShellIdentity {
  user: string;
  home: string;
}

export const DEFAULT_IDENTITY: ShellIdentity = { user: 'user', home: DEFAULT_HOME_DIR };

const RESERVED = new Set(['root', 'nobody', 'nogroup']);
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

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

export function identityFile(
  path: string,
  identity: ShellIdentity = DEFAULT_IDENTITY
): Uint8Array | undefined {
  const text = contents(path, identity);
  return text === undefined ? undefined : new TextEncoder().encode(text);
}

export function identityFileNames(dir: string): string[] {
  return dir === '/etc' ? ['group', 'passwd'] : [];
}

export function isMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}
