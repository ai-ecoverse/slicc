/**
 * Tests for the API key dialog (localStorage persistence).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getApiKey, setApiKey, clearApiKey,
  getProvider, setProvider, clearProvider,
  getAzureResource, setAzureResource, clearAzureResource,
  getBedrockRegion, setBedrockRegion, clearBedrockRegion,
} from './api-key-dialog.js';

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

describe('Provider storage', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('defaults to anthropic when no provider set', () => {
    expect(getProvider()).toBe('anthropic');
  });

  it('stores and retrieves provider', () => {
    setProvider('azure');
    expect(getProvider()).toBe('azure');
  });

  it('stores bedrock provider', () => {
    setProvider('bedrock');
    expect(getProvider()).toBe('bedrock');
  });

  it('clears provider back to default', () => {
    setProvider('azure');
    clearProvider();
    expect(getProvider()).toBe('anthropic');
  });
});

describe('Azure resource storage', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns null when no resource set', () => {
    expect(getAzureResource()).toBeNull();
  });

  it('stores and retrieves resource', () => {
    setAzureResource('my-resource');
    expect(getAzureResource()).toBe('my-resource');
  });

  it('clears resource', () => {
    setAzureResource('my-resource');
    clearAzureResource();
    expect(getAzureResource()).toBeNull();
  });

  it('removes key when empty string provided', () => {
    setAzureResource('my-resource');
    setAzureResource('');
    expect(getAzureResource()).toBeNull();
  });
});

describe('Bedrock region storage', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns null when no region set', () => {
    expect(getBedrockRegion()).toBeNull();
  });

  it('stores and retrieves region', () => {
    setBedrockRegion('https://bedrock-runtime.us-east-1.amazonaws.com');
    expect(getBedrockRegion()).toBe('https://bedrock-runtime.us-east-1.amazonaws.com');
  });

  it('clears region', () => {
    setBedrockRegion('https://bedrock-runtime.us-east-1.amazonaws.com');
    clearBedrockRegion();
    expect(getBedrockRegion()).toBeNull();
  });

  it('removes key when empty string provided', () => {
    setBedrockRegion('https://bedrock-runtime.us-east-1.amazonaws.com');
    setBedrockRegion('');
    expect(getBedrockRegion()).toBeNull();
  });
});
