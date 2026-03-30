import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';

function createTempSecretsFile(content: string): string {
  const dir = join(tmpdir(), `slicc-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'secrets.env');
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

describe('SecretProxyManager', () => {
  let filePath: string;
  let manager: SecretProxyManager;

  beforeEach(() => {
    filePath = createTempSecretsFile(
      [
        'GITHUB_TOKEN=ghp_realtoken123456789abcdef',
        'GITHUB_TOKEN_DOMAINS=api.github.com,*.github.com',
        'OPENAI_KEY=sk-realopenaikey999888777',
        'OPENAI_KEY_DOMAINS=api.openai.com',
      ].join('\n')
    );

    const store = new EnvSecretStore(filePath);
    manager = new SecretProxyManager(store, 'test-session-id');
  });

  it('loads secrets and generates masked values', async () => {
    await manager.reload();
    expect(manager.hasSecrets()).toBe(true);

    const entries = manager.getMaskedEntries();
    expect(entries).toHaveLength(2);

    const gh = entries.find((e) => e.name === 'GITHUB_TOKEN');
    expect(gh).toBeDefined();
    expect(gh!.maskedValue).not.toBe('ghp_realtoken123456789abcdef');
    // Masked value should preserve the ghp_ prefix
    expect(gh!.maskedValue.startsWith('ghp_')).toBe(true);
    expect(gh!.maskedValue.length).toBe('ghp_realtoken123456789abcdef'.length);

    const oai = entries.find((e) => e.name === 'OPENAI_KEY');
    expect(oai).toBeDefined();
    expect(oai!.maskedValue.startsWith('sk-')).toBe(true);
  });

  it('unmasks text when domain is allowed', async () => {
    await manager.reload();
    const gh = manager.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!;

    const result = manager.unmask(`Bearer ${gh.maskedValue}`, 'api.github.com');
    expect(result.forbidden).toBeUndefined();
    expect(result.text).toBe('Bearer ghp_realtoken123456789abcdef');
  });

  it('blocks unmask when domain is not allowed', async () => {
    await manager.reload();
    const gh = manager.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!;

    const result = manager.unmask(`Bearer ${gh.maskedValue}`, 'evil.com');
    expect(result.forbidden).toBeDefined();
    expect(result.forbidden!.secretName).toBe('GITHUB_TOKEN');
    expect(result.forbidden!.hostname).toBe('evil.com');
  });

  it('allows wildcard subdomain matching', async () => {
    await manager.reload();
    const gh = manager.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!;

    const result = manager.unmask(`Bearer ${gh.maskedValue}`, 'uploads.github.com');
    expect(result.forbidden).toBeUndefined();
    expect(result.text).toBe('Bearer ghp_realtoken123456789abcdef');
  });

  it('unmasks headers and rejects on domain mismatch', async () => {
    await manager.reload();
    const oai = manager.getMaskedEntries().find((e) => e.name === 'OPENAI_KEY')!;

    // Allowed domain
    const headers1: Record<string, string> = {
      authorization: `Bearer ${oai.maskedValue}`,
      'content-type': 'application/json',
    };
    const r1 = manager.unmaskHeaders(headers1, 'api.openai.com');
    expect(r1.forbidden).toBeUndefined();
    expect(headers1['authorization']).toBe('Bearer sk-realopenaikey999888777');

    // Disallowed domain
    const headers2: Record<string, string> = {
      authorization: `Bearer ${oai.maskedValue}`,
    };
    const r2 = manager.unmaskHeaders(headers2, 'evil.com');
    expect(r2.forbidden).toBeDefined();
    expect(r2.forbidden!.secretName).toBe('OPENAI_KEY');
  });

  it('scrubs real values from response text', async () => {
    await manager.reload();
    const responseBody = JSON.stringify({
      token: 'ghp_realtoken123456789abcdef',
      key: 'sk-realopenaikey999888777',
    });

    const scrubbed = manager.scrubResponse(responseBody);
    expect(scrubbed).not.toContain('ghp_realtoken123456789abcdef');
    expect(scrubbed).not.toContain('sk-realopenaikey999888777');

    // Should contain masked values instead
    const gh = manager.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!;
    const oai = manager.getMaskedEntries().find((e) => e.name === 'OPENAI_KEY')!;
    expect(scrubbed).toContain(gh.maskedValue);
    expect(scrubbed).toContain(oai.maskedValue);
  });

  it('passes through text unchanged when no secrets match', async () => {
    await manager.reload();
    const text = 'Hello world, no secrets here';
    expect(manager.unmask(text, 'example.com').text).toBe(text);
    expect(manager.scrubResponse(text)).toBe(text);
  });

  it('handles empty secret store', async () => {
    const emptyPath = createTempSecretsFile('');
    const emptyStore = new EnvSecretStore(emptyPath);
    const emptyManager = new SecretProxyManager(emptyStore, 'test-session');
    await emptyManager.reload();

    expect(emptyManager.hasSecrets()).toBe(false);
    expect(emptyManager.getMaskedEntries()).toHaveLength(0);
    expect(emptyManager.unmask('text', 'example.com').text).toBe('text');
    expect(emptyManager.scrubResponse('text')).toBe('text');
  });

  it('produces deterministic masked values for same session', async () => {
    await manager.reload();
    const entries1 = manager.getMaskedEntries();

    // Reload — same session ID should produce same masks
    await manager.reload();
    const entries2 = manager.getMaskedEntries();

    for (const e1 of entries1) {
      const e2 = entries2.find((e) => e.name === e1.name)!;
      expect(e1.maskedValue).toBe(e2.maskedValue);
    }
  });
});
