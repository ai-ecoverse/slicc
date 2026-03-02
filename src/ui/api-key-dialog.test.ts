/**
 * Tests for the API key dialog (localStorage persistence).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getApiKey, setApiKey, clearApiKey } from './api-key-dialog.js';

// Mock localStorage
const storage = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
  removeItem: vi.fn((key: string) => { storage.delete(key); }),
  clear: vi.fn(() => storage.clear()),
  get length() { return storage.size; },
  key: vi.fn((_i: number) => null),
};

Object.defineProperty(globalThis, 'localStorage', { value: mockStorage });

describe('API key storage', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns null when no key is set', () => {
    expect(getApiKey()).toBeNull();
  });

  it('stores and retrieves an API key', () => {
    setApiKey('sk-ant-test-key-123');
    expect(getApiKey()).toBe('sk-ant-test-key-123');
  });

  it('clears the API key', () => {
    setApiKey('sk-ant-test-key-123');
    clearApiKey();
    expect(getApiKey()).toBeNull();
  });

  it('overwrites existing key', () => {
    setApiKey('key-1');
    setApiKey('key-2');
    expect(getApiKey()).toBe('key-2');
  });
});
