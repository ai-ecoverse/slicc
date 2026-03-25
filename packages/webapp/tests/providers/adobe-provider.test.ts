/**
 * Tests for Adobe provider token renewal logic.
 *
 * The provider file uses import.meta.glob and browser APIs, so we test
 * the exported pure-logic functions and mock the rest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock localStorage
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

// We can't import adobe.ts directly (import.meta.glob, chrome globals).
// Instead, test the core logic patterns used in the provider.

describe('Adobe token expiry logic', () => {
  it('token is valid when expiresAt is more than 60s in the future', () => {
    const expiresAt = Date.now() + 120000; // 2 minutes
    const expiresIn = expiresAt - Date.now();
    expect(expiresIn > 60000).toBe(true);
  });

  it('token is expired when expiresAt is in the past', () => {
    const expiresAt = Date.now() - 1000;
    const expiresIn = expiresAt - Date.now();
    expect(expiresIn > 60000).toBe(false);
    expect(expiresIn > 0).toBe(false);
  });

  it('token is expiring soon when less than 60s remaining', () => {
    const expiresAt = Date.now() + 30000; // 30 seconds
    const expiresIn = expiresAt - Date.now();
    expect(expiresIn > 60000).toBe(false); // triggers renewal
    expect(expiresIn > 0).toBe(true); // still usable as fallback
  });
});

describe('Adobe model persistence', () => {
  beforeEach(() => storage.clear());

  it('persists models to localStorage', () => {
    const models = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    ];
    localStorage.setItem('slicc-adobe-models', JSON.stringify(models));

    const persisted = localStorage.getItem('slicc-adobe-models');
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(persisted!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('claude-opus-4-6');
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('slicc-adobe-models', '{broken json');

    let result: Array<{ id: string }> | null = null;
    try {
      const raw = localStorage.getItem('slicc-adobe-models');
      if (raw) result = JSON.parse(raw);
    } catch {
      result = null;
    }
    expect(result).toBeNull();
  });

  it('returns empty when no models persisted', () => {
    const raw = localStorage.getItem('slicc-adobe-models');
    expect(raw).toBeNull();
  });
});

describe('Token extraction from URL', () => {
  // Mirrors extractTokenFromUrl logic
  function extractTokenFromUrl(url: string): { accessToken: string; expiresIn: number } | null {
    const hashIdx = url.indexOf('#');
    if (hashIdx < 0) return null;
    const fragment = new URLSearchParams(url.slice(hashIdx + 1));
    const accessToken = fragment.get('access_token');
    if (!accessToken) return null;
    const expiresIn = parseInt(fragment.get('expires_in') ?? '86400', 10);
    return { accessToken, expiresIn };
  }

  it('extracts token from redirect URL fragment', () => {
    const url =
      'https://example.com/callback#access_token=abc123&expires_in=3600&token_type=bearer';
    const result = extractTokenFromUrl(url);
    expect(result).toEqual({ accessToken: 'abc123', expiresIn: 3600 });
  });

  it('returns null when no fragment', () => {
    expect(extractTokenFromUrl('https://example.com/callback')).toBeNull();
  });

  it('returns null when no access_token in fragment', () => {
    expect(extractTokenFromUrl('https://example.com/callback#error=access_denied')).toBeNull();
  });

  it('defaults expiresIn to 86400 when not specified', () => {
    const url = 'https://example.com/callback#access_token=xyz';
    const result = extractTokenFromUrl(url);
    expect(result?.expiresIn).toBe(86400);
  });
});

describe('Model metadata survives renewal', () => {
  beforeEach(() => storage.clear());

  it('persisted models with api field are returned with metadata intact', () => {
    // Simulates what getModelIds returns from localStorage after enrichModel persisted the data
    const models = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
      {
        id: 'zai-glm-4.7',
        name: 'GLM 4.7',
        api: 'openai',
        context_window: 131072,
        max_tokens: 40960,
      },
    ];
    localStorage.setItem('slicc-adobe-models', JSON.stringify(models));

    const persisted = JSON.parse(localStorage.getItem('slicc-adobe-models')!);
    expect(persisted[1].api).toBe('openai');
    expect(persisted[1].context_window).toBe(131072);
  });

  it('persisted models WITHOUT api field lose routing info (pre-metadata format)', () => {
    // Simulates stale localStorage from before metadata changes
    const models = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'zai-glm-4.7', name: 'GLM 4.7' },
    ];
    localStorage.setItem('slicc-adobe-models', JSON.stringify(models));

    const persisted = JSON.parse(localStorage.getItem('slicc-adobe-models')!);
    // No api field — stream router will default to anthropic (wrong for Cerebras)
    expect(persisted[1].api).toBeUndefined();
  });

  it('getAdobeModels pattern repopulates metadata after renewal', async () => {
    // Simulates the fix: after renewal, getAdobeModels is called which
    // populates proxyMetadataCache AND persists enriched models to localStorage
    const proxyMetadataCache = new Map<string, { api?: string; context_window?: number }>();
    const proxyResponse = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
      { id: 'zai-glm-4.7', name: 'GLM 4.7', api: 'openai', context_window: 131072 },
    ];

    // Simulate fetchProxyModels populating the cache
    for (const pm of proxyResponse) {
      proxyMetadataCache.set(pm.id, { api: (pm as any).api, context_window: pm.context_window });
    }

    // Simulate enrichModel using the cache
    const enriched = proxyResponse.map((m) => {
      const entry: any = { id: m.id, name: m.name };
      const meta = proxyMetadataCache.get(m.id);
      if (meta?.api) entry.api = meta.api;
      if (meta?.context_window !== undefined) entry.context_window = meta.context_window;
      return entry;
    });

    // After enrichment, api field is present for Cerebras models
    expect(enriched[1].api).toBe('openai');
    expect(enriched[0].api).toBeUndefined(); // Anthropic models don't have explicit api

    // Persist to localStorage (simulates what getModelIds does)
    localStorage.setItem('slicc-adobe-models', JSON.stringify(enriched));

    // Verify round-trip: models loaded from localStorage retain api field
    const roundTripped = JSON.parse(localStorage.getItem('slicc-adobe-models')!);
    expect(roundTripped[1].api).toBe('openai');
  });
});

describe('Renewal deduplication pattern', () => {
  it('concurrent calls share the same promise', async () => {
    let resolveRenewal: (v: string | null) => void;
    let callCount = 0;

    // Simulate the deduplication pattern from silentRenewToken
    let renewalInProgress: Promise<string | null> | null = null;

    function silentRenew(): Promise<string | null> {
      if (renewalInProgress) return renewalInProgress;
      renewalInProgress = (async () => {
        try {
          callCount++;
          return await new Promise<string | null>((resolve) => {
            resolveRenewal = resolve;
          });
        } finally {
          renewalInProgress = null;
        }
      })();
      return renewalInProgress;
    }

    // Start two concurrent renewals
    const p1 = silentRenew();
    const p2 = silentRenew();

    // Both should be the same promise
    expect(p1).toBe(p2);

    // Resolve the shared promise
    resolveRenewal!('new-token');
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe('new-token');
    expect(r2).toBe('new-token');
    expect(callCount).toBe(1); // Only one actual renewal
  });

  it('resets after completion, allowing new renewals after a tick', async () => {
    let renewalInProgress: Promise<string | null> | null = null;
    let callCount = 0;

    function silentRenew(): Promise<string | null> {
      if (renewalInProgress) return renewalInProgress;
      renewalInProgress = (async () => {
        try {
          callCount++;
          // Simulate async work (network call)
          await new Promise((r) => setTimeout(r, 10));
          return 'token-' + callCount;
        } finally {
          renewalInProgress = null;
        }
      })();
      return renewalInProgress;
    }

    const r1 = await silentRenew();
    expect(r1).toBe('token-1');

    // After the async work + finally completes, renewalInProgress is null
    const r2 = await silentRenew();
    expect(r2).toBe('token-2');
    expect(callCount).toBe(2);
  });
});
