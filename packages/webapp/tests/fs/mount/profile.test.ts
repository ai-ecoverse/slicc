import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDefaultSecretStore,
  ProfileNotConfiguredError,
  resolveDaProfile,
  resolveS3Profile,
} from '../../../src/fs/mount/profile.js';
import { setBridgeToken, setLocalApiBaseUrl } from '../../../src/shell/proxied-fetch.js';
import { createFakeImsClient } from './helpers/fake-ims-client.js';
import { createFakeSecretStore } from './helpers/fake-secret-store.js';

describe('resolveS3Profile', () => {
  it('reads a complete default profile', async () => {
    const store = createFakeSecretStore({
      's3.default.access_key_id': 'AKIA1',
      's3.default.secret_access_key': 'SAK1',
      's3.default.region': 'us-west-2',
    });
    const profile = await resolveS3Profile('default', store);
    expect(profile.accessKeyId).toBe('AKIA1');
    expect(profile.secretAccessKey).toBe('SAK1');
    expect(profile.region).toBe('us-west-2');
    expect(profile.endpoint).toBeUndefined();
    expect(profile.sessionToken).toBeUndefined();
  });

  it('reads optional fields when present (endpoint, sessionToken)', async () => {
    const store = createFakeSecretStore({
      's3.r2.access_key_id': '9d8e',
      's3.r2.secret_access_key': 'sak',
      's3.r2.region': 'auto',
      's3.r2.endpoint': 'https://abc123.r2.cloudflarestorage.com',
      's3.r2.session_token': 'sess',
    });
    const profile = await resolveS3Profile('r2', store);
    expect(profile.endpoint).toBe('https://abc123.r2.cloudflarestorage.com');
    expect(profile.sessionToken).toBe('sess');
  });

  it('defaults region to us-east-1 when omitted', async () => {
    const store = createFakeSecretStore({
      's3.default.access_key_id': 'AKIA1',
      's3.default.secret_access_key': 'SAK1',
    });
    const profile = await resolveS3Profile('default', store);
    expect(profile.region).toBe('us-east-1');
  });

  it('throws ProfileNotConfiguredError naming the missing secret_access_key', async () => {
    const store = createFakeSecretStore({
      's3.r2.access_key_id': 'AKIA1',
      // secret_access_key missing
    });
    await expect(resolveS3Profile('r2', store)).rejects.toThrow(ProfileNotConfiguredError);
    await expect(resolveS3Profile('r2', store)).rejects.toThrow(/secret_access_key/);
  });

  it('throws ProfileNotConfiguredError naming the missing access_key_id', async () => {
    const store = createFakeSecretStore({});
    await expect(resolveS3Profile('r2', store)).rejects.toThrow(/access_key_id/);
  });

  it('error message includes the secret-set hint', async () => {
    const store = createFakeSecretStore({});
    await expect(resolveS3Profile('r2', store)).rejects.toThrow(/secret set s3\.r2\.access_key_id/);
  });
});

describe('resolveDaProfile', () => {
  it('returns a profile that delegates to the IMS client', async () => {
    const ims = createFakeImsClient('initial-token');
    const profile = await resolveDaProfile('default', ims);
    expect(await profile.getBearerToken()).toBe('initial-token');
    ims.setToken('refreshed-token');
    expect(await profile.getBearerToken()).toBe('refreshed-token');
    expect(profile.identity).toBe('adobe-ims');
  });

  it('uses ims.identity when provided', async () => {
    const ims = createFakeImsClient('t');
    const profile = await resolveDaProfile('default', ims);
    expect(profile.identity).toBe('adobe-ims');
  });

  it('falls back to "adobe-ims" identity when ims.identity is undefined', async () => {
    const ims = {
      getBearerToken: async () => 't',
      // identity intentionally undefined
    };
    const profile = await resolveDaProfile('default', ims);
    expect(profile.identity).toBe('adobe-ims');
  });
});

describe('getDefaultSecretStore (browser) — thin-bridge URL + token', () => {
  // The function picks the browser branch when `window` exists and `process`
  // does not. Stub both globals for the duration of each test.
  const originalProcess = (globalThis as { process?: unknown }).process;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;

  function stubBrowserContext() {
    (globalThis as { window?: unknown }).window = {};
    delete (globalThis as { process?: unknown }).process;
  }

  afterEach(() => {
    if (originalProcess === undefined) {
      delete (globalThis as { process?: unknown }).process;
    } else {
      (globalThis as { process?: unknown }).process = originalProcess;
    }
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    globalThis.fetch = originalFetch;
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
  });

  it('legacy / same-origin: hits the relative path with no X-Bridge-Token', async () => {
    stubBrowserContext();
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const store = await getDefaultSecretStore();
    await store.get('any.key');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/secrets');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBeUndefined();
  });

  it('thin-bridge: hits the bridge origin with X-Bridge-Token', async () => {
    stubBrowserContext();
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const store = await getDefaultSecretStore();
    await store.get('any.key');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('http://localhost:5710/api/secrets');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBe('abc-123');
  });

  it('token set but no base → relative path, X-Bridge-Token omitted', async () => {
    stubBrowserContext();
    setBridgeToken('abc-123');
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const store = await getDefaultSecretStore();
    await store.get('any.key');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/secrets');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBeUndefined();
  });
});
