import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProviderEnvSeed,
  PROVIDER_API_KEY_ENV,
  providerApiKeyEnvName,
  registerProviderEnvSeeder,
  resolveProviderEnvSeed,
} from '../../src/shell/provider-env-seed.js';

afterEach(() => {
  registerProviderEnvSeeder(null);
});

describe('providerApiKeyEnvName', () => {
  it('maps pi-ai provider ids to their SDK env names', () => {
    expect(providerApiKeyEnvName('vercel-ai-gateway')).toBe('AI_GATEWAY_API_KEY');
    expect(providerApiKeyEnvName('openai')).toBe('OPENAI_API_KEY');
    expect(providerApiKeyEnvName('google')).toBe('GEMINI_API_KEY');
  });

  it('returns null for providers without an env convention', () => {
    expect(providerApiKeyEnvName('github')).toBeNull();
    expect(providerApiKeyEnvName('bedrock-camp')).toBeNull();
  });

  it('never maps two env names to one provider (table is a plain string map)', () => {
    for (const [provider, name] of Object.entries(PROVIDER_API_KEY_ENV)) {
      expect(typeof provider).toBe('string');
      expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
});

describe('PROVIDER_API_KEY_ENV mirrors the installed pi-ai', () => {
  it('matches the envMap in @earendil-works/pi-ai/dist/env-api-keys.js (plus its special cases)', () => {
    // pi-ai does not export the table, so read the module source and extract
    // the literal map; a pi-ai bump that renames an env var fails here instead
    // of silently seeding the wrong variable.
    // `node:module` is shimmed out of the webapp vitest project, so resolve the
    // workspace-hoisted package by path (mirrors the vfs-root tests).
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const piAiDir = resolve(repoRoot, 'node_modules/@earendil-works/pi-ai/dist/');
    const src = readFileSync(resolve(piAiDir, 'env-api-keys.js'), 'utf8');
    const start = src.indexOf('const envMap = {');
    const mapSrc = src.slice(start, src.indexOf('};', start));
    const upstream: Record<string, string> = {};
    for (const m of mapSrc.matchAll(/^\s*"?([A-Za-z0-9-]+)"?:\s*"([A-Z0-9_]+)",?$/gm)) {
      upstream[m[1]] = m[2];
    }
    // Hand-coded branches in pi-ai's getApiKeyEnvVars(): github-copilot is a
    // token, not an API key (not seeded); anthropic lists ANTHROPIC_API_KEY
    // among auth/oauth tokens, and the plain key is what we mirror.
    expect(Object.keys(upstream).length).toBeGreaterThan(20);
    expect(src).toContain('ANTHROPIC_API_KEY');
    const { anthropic, ...mirrored } = PROVIDER_API_KEY_ENV;
    expect(anthropic).toBe('ANTHROPIC_API_KEY');
    expect(mirrored).toEqual(upstream);
  });
});

describe('buildProviderEnvSeed', () => {
  const accounts = [
    { providerId: 'vercel-ai-gateway', apiKey: ' vck_abc ' },
    { providerId: 'openai', apiKey: 'sk-openai' },
    { providerId: 'anthropic', apiKey: '', accessToken: 'oauth-token' },
  ];

  it('seeds only the selected provider, trimmed, under its env name', () => {
    expect(buildProviderEnvSeed('vercel-ai-gateway', accounts)).toEqual({
      AI_GATEWAY_API_KEY: 'vck_abc',
    });
    expect(buildProviderEnvSeed('openai', accounts)).toEqual({ OPENAI_API_KEY: 'sk-openai' });
  });

  it('ignores OAuth-only accounts (access tokens go through oauth-token)', () => {
    expect(buildProviderEnvSeed('anthropic', accounts)).toEqual({});
  });

  it('is empty for unknown / unconfigured providers', () => {
    expect(buildProviderEnvSeed('groq', accounts)).toEqual({});
    expect(buildProviderEnvSeed('github', accounts)).toEqual({});
  });
});

describe('registerProviderEnvSeeder / resolveProviderEnvSeed', () => {
  it('resolves to an empty seed when nothing is registered', async () => {
    expect(await resolveProviderEnvSeed()).toEqual({});
  });

  it('runs the registered seeder (sync or async) and returns the previous one', async () => {
    expect(registerProviderEnvSeeder(() => ({ A: '1' }))).toBeNull();
    expect(await resolveProviderEnvSeed()).toEqual({ A: '1' });
    const prev = registerProviderEnvSeeder(async () => ({ B: '2' }));
    expect(typeof prev).toBe('function');
    expect(await resolveProviderEnvSeed()).toEqual({ B: '2' });
  });

  it('degrades to an empty seed when the seeder throws or returns nothing', async () => {
    registerProviderEnvSeeder(() => {
      throw new Error('storage unavailable');
    });
    expect(await resolveProviderEnvSeed()).toEqual({});
    registerProviderEnvSeeder((() => undefined) as unknown as () => Record<string, string>);
    expect(await resolveProviderEnvSeed()).toEqual({});
  });
});
