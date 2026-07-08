import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasChromeRuntimeConnect, isExtensionRealm } from '../../src/core/runtime-env.js';

describe('isExtensionRealm', () => {
  let originalChrome: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });

  it('returns true when chrome.runtime.id is a non-empty string', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: 'abc123' },
    };
    expect(isExtensionRealm()).toBe(true);
  });

  it('returns false when chrome.runtime.id is an empty string', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: '' },
    };
    expect(isExtensionRealm()).toBe(false);
  });

  it('returns false when chrome.runtime.id is undefined', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {},
    };
    expect(isExtensionRealm()).toBe(false);
  });

  it('returns false when chrome.runtime is undefined', () => {
    (globalThis as { chrome?: unknown }).chrome = {};
    expect(isExtensionRealm()).toBe(false);
  });

  it('returns false when chrome is undefined', () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    expect(isExtensionRealm()).toBe(false);
  });
});

describe('hasChromeRuntimeConnect', () => {
  let originalChrome: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });

  it('returns true when chrome.runtime.connect is a function', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect: () => undefined },
    };
    expect(hasChromeRuntimeConnect()).toBe(true);
  });

  it('returns false when chrome.runtime.connect is undefined', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: 'abc' },
    };
    expect(hasChromeRuntimeConnect()).toBe(false);
  });

  it('returns false when chrome is undefined', () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    expect(hasChromeRuntimeConnect()).toBe(false);
  });

  it('returns true on externally-connectable pages (connect present, no id)', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect: () => undefined },
    };
    expect(hasChromeRuntimeConnect()).toBe(true);
    expect(isExtensionRealm()).toBe(false);
  });
});
