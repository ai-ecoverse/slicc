// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyTextToClipboard, readTextFromClipboard } from '../../src/ui/clipboard.js';

interface MockNavigator {
  clipboard?: {
    writeText?: (t: string) => Promise<void>;
    readText?: () => Promise<string>;
  };
}

let originalNavigator: unknown;

beforeEach(() => {
  originalNavigator = (globalThis as { navigator?: unknown }).navigator;
});

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
  // Reset document.execCommand stub
  (document as unknown as { execCommand?: () => boolean }).execCommand = undefined;
});

function setNavigator(nav: MockNavigator): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: nav,
    configurable: true,
    writable: true,
  });
}

describe('copyTextToClipboard', () => {
  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns false for empty input without touching the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });

    await expect(copyTextToClipboard('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to document.execCommand when the async API is missing', async () => {
    setNavigator({});
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;

    await expect(copyTextToClipboard('hi')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when writeText throws', async () => {
    setNavigator({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;

    await expect(copyTextToClipboard('hi')).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });
});

describe('readTextFromClipboard', () => {
  it('returns the clipboard contents when readText is available', async () => {
    const readText = vi.fn().mockResolvedValue('  pasted  ');
    setNavigator({ clipboard: { readText } });

    await expect(readTextFromClipboard()).resolves.toBe('  pasted  ');
  });

  it('returns null when the API is missing', async () => {
    setNavigator({});
    await expect(readTextFromClipboard()).resolves.toBeNull();
  });

  it('returns null when readText throws (e.g. permission denied)', async () => {
    setNavigator({
      clipboard: { readText: () => Promise.reject(new Error('NotAllowedError')) },
    });
    await expect(readTextFromClipboard()).resolves.toBeNull();
  });
});
