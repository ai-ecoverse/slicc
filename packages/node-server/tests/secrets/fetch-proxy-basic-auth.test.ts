import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';
import { readOrCreateSessionId } from '../../src/secrets/session-id-file.js';

describe('fetch-proxy Basic-auth round-trip (unit)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-bauth-'));
    writeFileSync(
      join(dir, 'secrets.env'),
      'GITHUB_TOKEN=ghp_realToken123\nGITHUB_TOKEN_DOMAINS=github.com,*.github.com\n'
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('decodes Basic, unmasks password, re-encodes via unmaskHeaders', async () => {
    const envFile = join(dir, 'secrets.env');
    const sessionId = readOrCreateSessionId(dir);
    const proxy = new SecretProxyManager(new EnvSecretStore(envFile), sessionId);
    await proxy.reload();
    const masked = proxy.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!.maskedValue;
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`x-access-token:${masked}`).toString('base64')}`,
    };
    const result = proxy.unmaskHeaders(headers, 'github.com');
    expect(result.forbidden).toBeUndefined();
    const decoded = Buffer.from(headers.authorization.replace(/^Basic /, ''), 'base64').toString();
    expect(decoded).toBe('x-access-token:ghp_realToken123');
  });

  it('strips userinfo and synthesizes Authorization for masked PAT in URL', async () => {
    const envFile = join(dir, 'secrets.env');
    const sessionId = readOrCreateSessionId(dir);
    const proxy = new SecretProxyManager(new EnvSecretStore(envFile), sessionId);
    await proxy.reload();
    const masked = proxy.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!.maskedValue;
    const url = `https://x-access-token:${masked}@github.com/owner/repo.git`;
    const result = proxy.extractAndUnmaskUrlCredentials(url);
    expect(result.forbidden).toBeUndefined();
    expect(result.url).toBe('https://github.com/owner/repo.git');
    expect(result.syntheticAuthorization).toBeDefined();
    const decoded = Buffer.from(
      result.syntheticAuthorization!.replace(/^Basic /, ''),
      'base64'
    ).toString();
    expect(decoded).toBe('x-access-token:ghp_realToken123');
  });

  it('returns forbidden when URL host is not in the secret allowlist', async () => {
    const envFile = join(dir, 'secrets.env');
    const sessionId = readOrCreateSessionId(dir);
    const proxy = new SecretProxyManager(new EnvSecretStore(envFile), sessionId);
    await proxy.reload();
    const masked = proxy.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!.maskedValue;
    const result = proxy.extractAndUnmaskUrlCredentials(`https://u:${masked}@evil.example.com/`);
    expect(result.forbidden).toEqual({ secretName: 'GITHUB_TOKEN', hostname: 'evil.example.com' });
  });
});
