import type { CommandContext } from 'just-bash';
import { expect, test } from 'vitest';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import {
  mintSyncFsToken,
  resolveSyncFsToken,
  revokeSyncFsToken,
} from '../../../src/kernel/realm/sync-fs-token-registry.js';

const fakeFs = {} as never;

function fakePort(): RealmPortLike {
  return {
    postMessage: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const fakeCtx = { fs: fakeFs, cwd: '/scoops/x' } as unknown as CommandContext;

test('mint → resolve returns the same entry; unknown token is null', () => {
  const token = mintSyncFsToken({ fs: fakeFs, cwd: '/scoops/x' });
  expect(token).toMatch(/[0-9a-f-]{36}/);
  expect(resolveSyncFsToken(token)).toEqual({ fs: fakeFs, cwd: '/scoops/x' });
  expect(resolveSyncFsToken('nope')).toBeNull();
});

test('revoke makes the token unresolvable (no reuse)', () => {
  const token = mintSyncFsToken({ fs: fakeFs, cwd: '/' });
  revokeSyncFsToken(token);
  expect(resolveSyncFsToken(token)).toBeNull();
});

test('two mints are distinct and isolated', () => {
  const a = mintSyncFsToken({ fs: fakeFs, cwd: '/a' });
  const b = mintSyncFsToken({ fs: fakeFs, cwd: '/b' });
  expect(a).not.toBe(b);
  expect(resolveSyncFsToken(a)?.cwd).toBe('/a');
  expect(resolveSyncFsToken(b)?.cwd).toBe('/b');
});

test('revoking an unknown token is a no-op (no throw)', () => {
  expect(() => revokeSyncFsToken('does-not-exist')).not.toThrow();
});

test('attachRealmHost mints a resolvable token when the bridge is enabled', () => {
  const host = attachRealmHost(fakePort(), fakeCtx, { syncFsBridgeEnabled: true });
  expect(host.syncFsToken).toMatch(/[0-9a-f-]{36}/);
  expect(resolveSyncFsToken(host.syncFsToken as string)).toEqual({
    fs: fakeCtx.fs,
    cwd: '/scoops/x',
  });
  host.dispose();
  // dispose revokes it → no reuse
  expect(resolveSyncFsToken(host.syncFsToken as string)).toBeNull();
});

test('attachRealmHost mints no token when the bridge is disabled (default)', () => {
  const host = attachRealmHost(fakePort(), fakeCtx, {});
  expect(host.syncFsToken).toBeUndefined();
  host.dispose();
});
