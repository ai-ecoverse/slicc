// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc/wc-dom-stubs.js';

installWcDomStubs();

const globalFiles = new Map<string, unknown>();
vi.mock('../../src/fs/index.js', () => ({
  VirtualFS: {
    create: async () => ({
      readFile: async (path: string) => {
        const value = globalFiles.get(path);
        if (value === undefined) throw new Error('ENOENT');
        return value;
      },
    }),
  },
}));
const db = {
  getAllCronTasks: vi.fn(async () => [{ id: 'c' }]),
  getAllTasks: vi.fn(async () => [{ id: 't' }]),
  getAllWebhooks: vi.fn(async () => [{ id: 'w' }]),
};
vi.mock('../../src/scoops/db.js', () => db);
let mountEntries: () => Promise<{ targetPath: string }[]> = async () => [{ targetPath: '/mnt/a' }];
vi.mock('../../src/fs/mount-table-store.js', () => ({ getAllMountEntries: () => mountEntries() }));
let topology = 'node-rest';
vi.mock('../../src/core/secret-topology.js', () => ({ resolveSecretTopology: () => topology }));
let secretEntries: () => Promise<{ entries: unknown[] }> = async () => ({
  entries: [{ name: 'X' }],
});
vi.mock('../../src/shell/supplemental-commands/secret-backends.js', () => ({
  createDefaultSecretBackend: () => ({ list: () => secretEntries() }),
}));
vi.mock('../../src/scoops/skills.js', () => ({
  readBundledFile: async (path: string) => (path === '/b' ? new Uint8Array([1]) : null),
}));

import { DefaultTranscriptExportService } from '../../src/transcript/export-service.js';
import { createPageProfileExportDeps } from '../../src/ui/profile-export-deps.js';

function deps() {
  const redactor = { redact: async (t: readonly string[]) => [...t] };
  return createPageProfileExportDeps({
    serviceDeps: {
      collection: {} as never,
      knownSecrets: redactor,
      snapshotStore: {} as never,
      vfs: {} as never,
      getActiveSessionInfo: () => ({ id: 'x', title: 'x' }),
      version: '6',
    },
    listUnits: () => [],
    version: '6.1.0',
  });
}

afterEach(() => {
  globalFiles.clear();
  localStorage.clear();
});

describe('createPageProfileExportDeps', () => {
  it('reads accounts, licks, mounts, global files and the bundled copy', async () => {
    const d = deps();
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'anthropic', apiKey: 'k' }, { nope: true }])
    );
    expect(d.accounts()).toEqual([{ providerId: 'anthropic', apiKey: 'k' }]);
    expect(await d.licks()).toEqual({
      crontasks: [{ id: 'c' }],
      tasks: [{ id: 't' }],
      webhooks: [{ id: 'w' }],
    });
    expect(await d.mounts()).toEqual(['/mnt/a']);
    globalFiles.set('/workspace/.git/github-token', '  ghp_x \n');
    globalFiles.set('/workspace/.gitconfig', '[user]\n');
    globalFiles.set(
      '/workspace/.mcp/servers.json',
      JSON.stringify({ servers: { a: { url: 'u' } } })
    );
    expect(await d.githubToken()).toBe('ghp_x');
    expect(await d.gitconfig()).toBe('[user]\n');
    expect(await d.mcpServers()).toEqual({ servers: { a: { url: 'u' } } });
    expect(await d.bundledFile('/b')).toEqual(new Uint8Array([1]));
    expect(d.version).toBe('6.1.0');
    expect(d.origin).toBe(location.origin);
    expect(d.createTranscriptSource(d.knownSecrets)).toBeInstanceOf(DefaultTranscriptExportService);
  });

  it('degrades to empty values when a store is missing or malformed', async () => {
    const d = deps();
    localStorage.setItem('slicc_accounts', '{bad');

    localStorage.setItem('slicc_accounts.corrupt', '[{"providerId":"openai","apiKey":"sk-x"}]');
    expect(d.accounts()).toEqual([]);
    localStorage.setItem('slicc_accounts', '{}');
    expect(d.accounts()).toEqual([]);
    expect(await d.githubToken()).toBeNull();
    expect(await d.mcpServers()).toBeNull();
    globalFiles.set('/workspace/.mcp/servers.json', '{bad');
    expect(await d.mcpServers()).toBeNull();
    globalFiles.set('/workspace/.mcp/servers.json', '[]');
    expect(await d.mcpServers()).toBeNull();
    globalFiles.set('/workspace/.gitconfig', new TextEncoder().encode('[user]\n'));
    expect(await d.gitconfig()).toBe('[user]\n');
    globalFiles.set('/workspace/.gitconfig', 42);
    expect(await d.gitconfig()).toBeNull();
    mountEntries = async () => {
      throw new Error('no idb');
    };
    expect(await d.mounts()).toEqual([]);
  });

  it('names the secret store six had, by float', async () => {
    const d = deps();
    topology = 'node-rest';
    expect(await d.storedSecretKinds()).toEqual(['secrets-env']);
    topology = 'extension-direct';
    expect(await d.storedSecretKinds()).toEqual(['chrome-storage']);
    secretEntries = async () => ({ entries: [] });
    expect(await d.storedSecretKinds()).toEqual([]);
    secretEntries = async () => {
      throw new Error('bridge down');
    };
    expect(await d.storedSecretKinds()).toEqual([]);
  });
});
