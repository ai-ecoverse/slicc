/**
 * Unit tests for the private backing of the shell's `/dev/fd/<n>` descriptors.
 * The sandbox-level behavior lives in `restricted-fs.test.ts`; the cone/scoop
 * equivalence guard lives in `shell/process-substitution-sandbox.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { EphemeralFdStore } from '../../src/fs/ephemeral-fd-store.js';
import { isEphemeralFdPath } from '../../src/fs/virtual-device-paths.js';

describe('isEphemeralFdPath', () => {
  it('matches numbered descriptors', () => {
    for (const path of ['/dev/fd/0', '/dev/fd/10', '/dev/fd/62', '/dev/fd/63']) {
      expect(isEphemeralFdPath(path)).toBe(true);
    }
  });

  it('rejects everything else, including the directory itself', () => {
    for (const path of [
      '/dev/fd',
      '/dev/fd/',
      '/dev/fd/name',
      '/dev/fd/63/child',
      '/dev/fd/007',
      '/dev/fd/-1',
      '/dev/fdx/63',
      '/dev/null',
      '/proc/self/fd/63',
      '/scoops/s/dev/fd/63',
    ]) {
      expect(isEphemeralFdPath(path)).toBe(false);
    }
  });
});

describe('EphemeralFdStore', () => {
  it('answers only for numbered descriptor paths', () => {
    expect(EphemeralFdStore.handles('/dev/fd/63')).toBe(true);
    // Normalization happens before the test, so a traversal cannot dodge it.
    expect(EphemeralFdStore.handles('/dev/fd/./63')).toBe(true);
    expect(EphemeralFdStore.handles('/dev/fd/62/../63')).toBe(true);
    expect(EphemeralFdStore.handles('/dev/null')).toBe(false);
    expect(EphemeralFdStore.handles('/workspace/fd/63')).toBe(false);
  });

  it('round-trips text and bytes', () => {
    const store = new EphemeralFdStore();
    store.write('/dev/fd/63', 'alpha\n');
    expect(store.has('/dev/fd/63')).toBe(true);
    expect(store.readText('/dev/fd/63')).toBe('alpha\n');
    expect(store.read('/dev/fd/63')).toBe('alpha\n');
    expect(store.read('/dev/fd/63', { encoding: 'binary' })).toEqual(
      new TextEncoder().encode('alpha\n')
    );

    store.write('/dev/fd/62', new Uint8Array([0x00, 0xff, 0x41]));
    expect(store.read('/dev/fd/62', { encoding: 'binary' })).toEqual(
      new Uint8Array([0x00, 0xff, 0x41])
    );
  });

  it('does not hand out a mutable view of its bytes', () => {
    const store = new EphemeralFdStore();
    const source = new Uint8Array([1, 2, 3]);
    store.write('/dev/fd/63', source);
    source[0] = 9;
    const read = store.read('/dev/fd/63', { encoding: 'binary' }) as Uint8Array;
    read[1] = 9;
    expect(store.read('/dev/fd/63', { encoding: 'binary' })).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('overwrites in place and keeps the creation time', () => {
    const store = new EphemeralFdStore();
    store.write('/dev/fd/63', 'first');
    const created = store.stat('/dev/fd/63').ctime;
    store.write('/dev/fd/63', 'second-and-longer');
    expect(store.readText('/dev/fd/63')).toBe('second-and-longer');
    expect(store.stat('/dev/fd/63')).toMatchObject({
      type: 'file',
      size: 'second-and-longer'.length,
      ctime: created,
    });
  });

  it('normalizes the key so one descriptor is one entry', () => {
    const store = new EphemeralFdStore();
    store.write('/dev/fd/63', 'once');
    store.write('/dev/fd/./63', 'twice');
    expect(store.readText('/dev/fd/63')).toBe('twice');
    expect(store.remove('/dev/fd/62/../63')).toBe(true);
    expect(store.has('/dev/fd/63')).toBe(false);
  });

  it('raises ENOENT for a descriptor that was never written', () => {
    const store = new EphemeralFdStore();
    expect(store.has('/dev/fd/63')).toBe(false);
    expect(() => store.read('/dev/fd/63')).toThrow(/no such file or directory/);
    expect(() => store.readText('/dev/fd/63')).toThrow(/no such file or directory/);
    expect(() => store.stat('/dev/fd/63')).toThrow(/no such file or directory/);
  });

  it('reports whether a release actually removed anything', () => {
    const store = new EphemeralFdStore();
    store.write('/dev/fd/63', 'x');
    expect(store.remove('/dev/fd/63')).toBe(true);
    expect(store.remove('/dev/fd/63')).toBe(false);
  });
});
