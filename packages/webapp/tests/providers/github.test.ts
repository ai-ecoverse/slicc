/**
 * Tests for GitHub provider URL extraction logic.
 *
 * The provider file uses import.meta.glob and browser APIs, so we mock
 * the heavy transitive dependencies and test the exported pure functions.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock localStorage (required by provider-settings.ts)
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
});

// Mock provider-settings (avoids pulling in core/index -> context-compaction
// -> pi-coding-agent, and providers/index -> bedrock-camp -> pi-ai deep imports)
vi.mock('../../src/ui/provider-settings.js', () => ({
  saveOAuthAccount: vi.fn(),
  getAccounts: vi.fn(() => []),
}));

// Mock VirtualFS (used by git token bridge, requires IndexedDB)
vi.mock('../../src/fs/index.js', () => ({
  VirtualFS: { create: vi.fn().mockResolvedValue({ writeFile: vi.fn(), rm: vi.fn() }) },
}));

import { extractCodeFromUrl } from '../../providers/github.js';

describe('extractCodeFromUrl', () => {
  it('extracts code from a redirect URL with query params', () => {
    const url = 'http://localhost:5710/auth/callback?nonce=abc&code=gh_auth_code_123';
    expect(extractCodeFromUrl(url)).toBe('gh_auth_code_123');
  });

  it('extracts code when it is the only query param', () => {
    const url = 'http://localhost:5710/auth/callback?code=single_code';
    expect(extractCodeFromUrl(url)).toBe('single_code');
  });

  it('returns null when no code param is present', () => {
    const url = 'http://localhost:5710/auth/callback?nonce=abc&state=xyz';
    expect(extractCodeFromUrl(url)).toBeNull();
  });

  it('returns null for a URL with no query string', () => {
    const url = 'http://localhost:5710/auth/callback';
    expect(extractCodeFromUrl(url)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractCodeFromUrl('')).toBeNull();
  });

  it('extracts code from extension redirect URL', () => {
    const url = 'https://akggccfpkleihhemkkikggopnifgelbk.chromiumapp.org/github?code=ext_code_456';
    expect(extractCodeFromUrl(url)).toBe('ext_code_456');
  });
});
