import { describe, expect, it } from 'vitest';
import {
  describeUnsupportedPlatform,
  INSTALL_HOST,
  isPlatformSupported,
} from '../../../src/shell/ipk/platform.js';

describe('INSTALL_HOST', () => {
  it('is a wasm host, not the linux/x64 the Node realm reports', () => {
    expect(INSTALL_HOST).toEqual({ os: 'wasi', cpu: 'wasm32', libc: undefined });
    expect(Object.isFrozen(INSTALL_HOST)).toBe(true);
  });
});

describe('isPlatformSupported on the wasm host', () => {
  it('rejects napi-rs native bindings and admits the wasm32-wasi one', () => {
    expect(isPlatformSupported({ os: ['darwin'], cpu: ['arm64'] })).toBe(false);
    expect(isPlatformSupported({ os: ['linux'], cpu: ['x64'], libc: ['glibc'] })).toBe(false);
    expect(isPlatformSupported({ os: ['win32'], cpu: ['x64'] })).toBe(false);
    expect(isPlatformSupported({ cpu: ['wasm32'] })).toBe(true);
    expect(isPlatformSupported({ os: ['wasi'], cpu: ['wasm32'] })).toBe(true);
  });

  it('requires both os and cpu to admit the host', () => {
    expect(isPlatformSupported({ os: ['linux'], cpu: ['wasm32'] })).toBe(false);
    expect(isPlatformSupported({ os: ['wasi'], cpu: ['x64'] })).toBe(false);
  });

  it('honors negated lists the way npm does', () => {
    expect(isPlatformSupported({ os: ['!win32'] })).toBe(true);
    expect(isPlatformSupported({ os: ['!win32', '!darwin'] })).toBe(true);
    expect(isPlatformSupported({ os: ['!wasi'] })).toBe(false);
    expect(isPlatformSupported({ cpu: ['!wasm32'] })).toBe(false);
    expect(isPlatformSupported({ os: ['!win32', 'linux'] })).toBe(false);
  });

  it('admits versions with no constraints, empty lists, or "any"', () => {
    expect(isPlatformSupported({})).toBe(true);
    expect(isPlatformSupported({ os: [], cpu: [] })).toBe(true);
    expect(isPlatformSupported({ os: ['any'], cpu: 'any' })).toBe(true);
  });

  it('accepts a bare string as a one-entry list', () => {
    expect(isPlatformSupported({ os: 'darwin' })).toBe(false);
    expect(isPlatformSupported({ cpu: 'wasm32' })).toBe(true);
  });

  it('ignores libc off linux, and checks it on a linux host', () => {
    expect(isPlatformSupported({ cpu: ['wasm32'], libc: ['glibc'] })).toBe(true);
    const linux = { os: 'linux', cpu: 'x64', libc: 'musl' };
    expect(isPlatformSupported({ libc: ['glibc'] }, linux)).toBe(false);
    expect(isPlatformSupported({ libc: ['musl'] }, linux)).toBe(true);
  });
});

describe('describeUnsupportedPlatform', () => {
  it('names only the constrained fields, npm-style', () => {
    expect(describeUnsupportedPlatform('fsevents@2.3.3', { os: ['darwin'] })).toBe(
      'Unsupported platform for fsevents@2.3.3: wanted {"os":["darwin"]} (current: {"os":"wasi"})'
    );
  });
});
