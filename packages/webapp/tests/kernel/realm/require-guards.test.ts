import { describe, expect, it, vi } from 'vitest';
import {
  LOAD_MODULE_TIMEOUT_MS,
  NATIVE_PACKAGE_HINTS,
  NODE_NATIVE_PACKAGES,
  nativePackageError,
  withTimeout,
} from '../../../src/kernel/realm/require-guards.js';

describe('NODE_NATIVE_PACKAGES', () => {
  it('includes the packages that ship C++ bindings via node-gyp/prebuild', () => {
    expect(NODE_NATIVE_PACKAGES.has('sharp')).toBe(true);
    expect(NODE_NATIVE_PACKAGES.has('canvas')).toBe(true);
    expect(NODE_NATIVE_PACKAGES.has('sqlite3')).toBe(true);
    expect(NODE_NATIVE_PACKAGES.has('better-sqlite3')).toBe(true);
    expect(NODE_NATIVE_PACKAGES.has('bcrypt')).toBe(true);
    expect(NODE_NATIVE_PACKAGES.has('fsevents')).toBe(true);
  });

  it('does not list pure-JS packages', () => {
    expect(NODE_NATIVE_PACKAGES.has('lodash')).toBe(false);
    expect(NODE_NATIVE_PACKAGES.has('path')).toBe(false);
    expect(NODE_NATIVE_PACKAGES.has('chalk')).toBe(false);
  });
});

describe('nativePackageError', () => {
  it('mentions the package id and explains the C++ binding constraint', () => {
    const err = nativePackageError('sharp', 'sharp');
    expect(err.message).toContain("require('sharp')");
    expect(err.message).toContain('Node native module');
    expect(err.message).toContain('C++ bindings');
    expect(err.message).toContain('browser sandbox');
  });

  it('appends a hint that points sharp callers at the built-in convert', () => {
    expect(nativePackageError('sharp', 'sharp').message).toContain(
      "Use the built-in 'convert' shell command"
    );
  });

  it('preserves the original specifier (node: prefix) in the rendered message', () => {
    const err = nativePackageError('node:sharp', 'sharp');
    expect(err.message).toContain("require('node:sharp')");
  });

  it('renders an empty hint when no suggestion is registered', () => {
    expect(NATIVE_PACKAGE_HINTS).not.toHaveProperty('fsevents');
    const err = nativePackageError('fsevents', 'fsevents');
    expect(err.message).not.toContain('undefined');
    expect(err.message).toMatch(/sandbox\.$/);
  });
});

describe('withTimeout', () => {
  it('resolves with the underlying value when the inner promise settles first', async () => {
    const inner = Promise.resolve('ok');
    await expect(withTimeout(inner, 1000, 'test')).resolves.toBe('ok');
  });

  it('propagates the inner rejection without wrapping', async () => {
    const inner = Promise.reject(new Error('boom'));
    await expect(withTimeout(inner, 1000, 'test')).rejects.toThrow('boom');
  });

  it('rejects with a clear timeout message when the inner promise hangs', async () => {
    vi.useFakeTimers();
    try {
      const stuck = new Promise<unknown>(() => {});
      const wrapped = withTimeout(stuck, 250, "require('sharp')");

      const settled = wrapped.then<Error, Error>(
        () => {
          throw new Error('expected rejection');
        },
        (e) => e as Error
      );
      await vi.advanceTimersByTimeAsync(250);
      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('Timed out after 0.25s');
      expect(err.message).toContain("loading require('sharp')");
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timeout on early resolution so it does not leak', async () => {
    vi.useFakeTimers();
    try {
      const wrapped = withTimeout(Promise.resolve('done'), 1_000_000, 'test');
      await expect(wrapped).resolves.toBe('done');

      await vi.advanceTimersByTimeAsync(1_500_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LOAD_MODULE_TIMEOUT_MS', () => {
  it('caps individual pre-fetches well under a panic-button threshold', () => {
    expect(LOAD_MODULE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(LOAD_MODULE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
