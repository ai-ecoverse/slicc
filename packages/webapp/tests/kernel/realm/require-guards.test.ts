import { describe, it, expect, vi } from 'vitest';
import {
  NODE_NATIVE_PACKAGES,
  NATIVE_PACKAGE_HINTS,
  LOAD_MODULE_TIMEOUT_MS,
  nativePackageError,
  withTimeout,
} from '../../../src/kernel/realm/require-guards.js';

describe('NODE_NATIVE_PACKAGES', () => {
  it('includes the packages that ship C++ bindings via node-gyp/prebuild', () => {
    // Anchor the most common offenders so a list trim doesn't
    // silently re-enable the realm hang.
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
    // `fsevents` is in the native set but not in NATIVE_PACKAGE_HINTS —
    // we still want a clean error without a trailing 'undefined'.
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
      const stuck = new Promise<unknown>(() => {
        /* never settles */
      });
      const wrapped = withTimeout(stuck, 250, "require('sharp')");
      // Catch eagerly so the unhandled-rejection settles before
      // vitest restores the timers and the test cleans up.
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
      // If the timer were still active, advancing past its delay
      // would reject a pre-resolved promise — but the test has
      // already resolved, so this should be a no-op.
      await vi.advanceTimersByTimeAsync(1_500_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LOAD_MODULE_TIMEOUT_MS', () => {
  it('caps individual pre-fetches well under a panic-button threshold', () => {
    // We want the realm to give up before a user reaches for ^C.
    // 15s is the contract; raising past 30s should require a
    // conscious "and the test reflected it" decision.
    expect(LOAD_MODULE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(LOAD_MODULE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
