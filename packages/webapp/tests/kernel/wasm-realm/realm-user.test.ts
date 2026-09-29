import { describe, expect, it } from 'vitest';
import type { ProcessFs } from '../../../src/kernel/wasm-realm/kernel-streams.js';
import { ownByRealmUser, REALM_GID, REALM_UID } from '../../../src/kernel/wasm-realm/realm-user.js';

describe('ownByRealmUser', () => {
  it('reports stat, lstat and fstat as owned by the realm user, the rest untouched', () => {
    const calls: unknown[] = [];
    const fs = {
      stat: (path: string, dontFollow?: boolean) => {
        calls.push(['stat', path, dontFollow]);
        return { uid: 0, gid: 0, mode: 0o100644, size: 3 };
      },
      fstat: (fd: number) => {
        calls.push(['fstat', fd]);
        return { uid: 501, gid: 20, mode: 0o10600 };
      },
    } as unknown as ProcessFs;
    ownByRealmUser(fs);
    expect(fs.stat?.('/a', true)).toEqual({
      uid: REALM_UID,
      gid: REALM_GID,
      mode: 0o100644,
      size: 3,
    });
    expect(fs.fstat?.(4)).toEqual({ uid: 1000, gid: 1000, mode: 0o10600 });
    expect(calls).toEqual([
      ['stat', '/a', true],
      ['fstat', 4],
    ]);
  });

  it('leaves an FS without stat alone', () => {
    const fs = {} as ProcessFs;
    ownByRealmUser(fs);
    expect(fs.stat).toBeUndefined();
    expect(fs.fstat).toBeUndefined();
  });
});
