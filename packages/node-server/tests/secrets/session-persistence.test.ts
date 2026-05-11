import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrCreateSessionId } from '../../src/secrets/session-id-file.js';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';

describe('session-id-file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-session-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates a UUID when no file exists and writes it with mode 0600', () => {
    const id = readOrCreateSessionId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const path = join(dir, 'session-id');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8').trim()).toBe(id);
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('reuses the existing UUID across calls', () => {
    const a = readOrCreateSessionId(dir);
    const b = readOrCreateSessionId(dir);
    expect(a).toBe(b);
  });

  it('overwrites empty or non-UUID corrupt files with a fresh UUID', () => {
    const path = join(dir, 'session-id');
    writeFileSync(path, '   \n');
    const id = readOrCreateSessionId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(path, 'utf-8').trim()).toBe(id);
  });
});

describe('mask round-trip across SecretProxyManager re-instantiations', () => {
  it('two managers using the same on-disk session-id produce identical masks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slicc-tripwire-'));
    try {
      const envPath = join(dir, 'secrets.env');
      writeFileSync(envPath, 'GITHUB_TOKEN=ghp_real\nGITHUB_TOKEN_DOMAINS=api.github.com\n');
      const sessionId1 = readOrCreateSessionId(dir);
      const sessionId2 = readOrCreateSessionId(dir);
      expect(sessionId1).toBe(sessionId2);

      const a = new SecretProxyManager(new EnvSecretStore(envPath), sessionId1);
      await a.reload();
      const b = new SecretProxyManager(new EnvSecretStore(envPath), sessionId2);
      await b.reload();
      const aEntry = a.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN');
      const bEntry = b.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN');
      expect(aEntry?.maskedValue).toBe(bEntry?.maskedValue);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
