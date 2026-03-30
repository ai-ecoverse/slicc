import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';

describe('EnvSecretStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: EnvSecretStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slicc-secrets-test-'));
    filePath = join(tmpDir, 'secrets.env');
    store = new EnvSecretStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent secret', () => {
    expect(store.get('NOPE')).toBeNull();
  });

  it('sets and gets a secret', () => {
    store.set('GITHUB_TOKEN', 'ghp_abc123', ['api.github.com', '*.github.com']);
    const secret = store.get('GITHUB_TOKEN');
    expect(secret).toEqual({
      name: 'GITHUB_TOKEN',
      value: 'ghp_abc123',
      domains: ['api.github.com', '*.github.com'],
    });
  });

  it('lists secrets without values', () => {
    store.set('A_KEY', 'secret1', ['api.a.com']);
    store.set('B_KEY', 'secret2', ['api.b.com', '*.b.com']);
    const list = store.list();
    expect(list).toEqual([
      { name: 'A_KEY', domains: ['api.a.com'] },
      { name: 'B_KEY', domains: ['api.b.com', '*.b.com'] },
    ]);
  });

  it('deletes a secret', () => {
    store.set('DEL_ME', 'val', ['example.com']);
    expect(store.get('DEL_ME')).not.toBeNull();
    store.delete('DEL_ME');
    expect(store.get('DEL_ME')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('updates an existing secret', () => {
    store.set('TOK', 'old', ['old.com']);
    store.set('TOK', 'new', ['new.com']);
    expect(store.get('TOK')).toEqual({
      name: 'TOK',
      value: 'new',
      domains: ['new.com'],
    });
    // Should not duplicate entries
    const content = readFileSync(filePath, 'utf-8');
    const tokCount = content.split('\n').filter((l) => l.startsWith('TOK=')).length;
    expect(tokCount).toBe(1);
  });

  it('rejects secrets without domains', () => {
    expect(() => store.set('NO_DOM', 'val', [])).toThrow(
      'must have at least one authorized domain'
    );
  });

  it('returns null for secret without _DOMAINS entry', () => {
    // Manually write a secret without domains
    const { writeFileSync } = require('node:fs');
    writeFileSync(filePath, 'ORPHAN=value\n');
    expect(store.get('ORPHAN')).toBeNull();
  });

  it('creates the file with restricted permissions', () => {
    store.set('X', 'val', ['x.com']);
    const stats = statSync(filePath);
    // 0o600 = owner read/write only
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates parent directories if they do not exist', () => {
    const deepPath = join(tmpDir, 'sub', 'dir', 'secrets.env');
    const deepStore = new EnvSecretStore(deepPath);
    deepStore.set('DEEP', 'val', ['deep.com']);
    expect(deepStore.get('DEEP')).toEqual({
      name: 'DEEP',
      value: 'val',
      domains: ['deep.com'],
    });
  });

  it('skips _DOMAINS keys when listing secret names', () => {
    store.set('MY_SECRET', 'val', ['my.com']);
    const list = store.list();
    expect(list.map((e) => e.name)).toEqual(['MY_SECRET']);
    // _DOMAINS entry should not appear as a separate secret
    expect(list.some((e) => e.name.endsWith('_DOMAINS'))).toBe(false);
  });

  it('persists across store instances', () => {
    store.set('PERSIST', 'val', ['p.com']);
    const store2 = new EnvSecretStore(filePath);
    expect(store2.get('PERSIST')).toEqual({
      name: 'PERSIST',
      value: 'val',
      domains: ['p.com'],
    });
  });
});
