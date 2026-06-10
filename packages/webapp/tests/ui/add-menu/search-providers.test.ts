import { describe, expect, it } from 'vitest';
import {
  createAggregator,
  createFileFolderProvider,
  createScoopProvider,
  createSessionProvider,
  createSkillProvider,
} from '../../../src/ui/add-menu/search-providers.js';

function fakeVfs(tree: Record<string, 'file' | 'directory'>) {
  return {
    async readDir(path: string) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names = new Set<string>();
      const out: { name: string; type: 'file' | 'directory' }[] = [];
      for (const [p, type] of Object.entries(tree)) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const seg = rest.split('/')[0];
          if (!seg || names.has(seg)) continue;
          names.add(seg);
          const isDir = rest.includes('/') || type === 'directory';
          out.push({ name: seg, type: isDir ? 'directory' : 'file' });
        }
      }
      return out;
    },
    async *walk(path: string) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      for (const [p, type] of Object.entries(tree)) {
        if (type === 'file' && p.startsWith(prefix)) yield p;
      }
    },
  } as never;
}

describe('createFileFolderProvider', () => {
  it('matches files and folders by path substring, prefix-ranked', async () => {
    const vfs = fakeVfs({
      '/workspace/CLAUDE.md': 'file',
      '/workspace/README.md': 'file',
      '/workspace/src': 'directory',
      '/workspace/src/main.ts': 'file',
    });
    const p = createFileFolderProvider(vfs, ['/workspace']);
    const res = await p.search('read', 10);
    expect(res.map((r) => r.locator)).toContain('/workspace/README.md');
    expect(res.every((r) => r.kind === 'file' || r.kind === 'folder')).toBe(true);

    const srcRes = await p.search('src', 10);
    expect(srcRes.some((r) => r.kind === 'folder' && r.locator === '/workspace/src')).toBe(true);
  });

  it('skips excluded subtrees so skills are not double-surfaced as files/folders', async () => {
    const vfs = fakeVfs({
      '/workspace/memory.md': 'file',
      '/workspace/skills/aem': 'directory',
      '/workspace/skills/aem/SKILL.md': 'file',
      '/workspace/skills/aem/scripts/aem.jsh': 'file',
    });
    const p = createFileFolderProvider(vfs, ['/workspace'], ['/workspace/skills']);
    const all = await p.search('', 50);
    const locators = all.map((r) => r.locator);
    expect(locators).toContain('/workspace/memory.md');
    expect(locators.some((l) => l.startsWith('/workspace/skills'))).toBe(false);
  });

  it('returns a default list for an empty query', async () => {
    const vfs = fakeVfs({ '/workspace/a.md': 'file', '/workspace/b.md': 'file' });
    const p = createFileFolderProvider(vfs, ['/workspace']);
    const res = await p.search('', 10);
    expect(res.length).toBeGreaterThan(0);
  });
});

describe('createSkillProvider', () => {
  it('lists /workspace/skills dirs, filtered by query', async () => {
    const vfs = fakeVfs({
      '/workspace/skills/sprinkles': 'directory',
      '/workspace/skills/frontend-design': 'directory',
    });
    const p = createSkillProvider(vfs);
    const all = await p.search('', 10);
    expect(all.map((r) => r.label).sort()).toEqual(['frontend-design', 'sprinkles']);
    const filtered = await p.search('spr', 10);
    expect(filtered.map((r) => r.label)).toEqual(['sprinkles']);
    expect(filtered[0].kind).toBe('skill');
  });
});

describe('createSessionProvider', () => {
  it('maps frozen-session entries to AddItems', async () => {
    const readIndex = async () => [
      { filename: '2026-06-01-foo.md', title: 'Fix the build', frozenAt: '', messageCount: 5 },
    ];
    const p = createSessionProvider(readIndex as never);
    const res = await p.search('fix', 10);
    expect(res[0]).toMatchObject({
      kind: 'session',
      label: 'Fix the build',
      locator: '/sessions/2026-06-01-foo.md',
    });
  });

  it('returns sessions newest-first when the query is empty', async () => {
    const readIndex = async () => [
      {
        filename: 'old.md',
        title: 'Old session',
        frozenAt: '2026-01-01T00:00:00Z',
        messageCount: 2,
      },
      {
        filename: 'new.md',
        title: 'New session',
        frozenAt: '2026-06-01T00:00:00Z',
        messageCount: 5,
      },
      {
        filename: 'mid.md',
        title: 'Mid session',
        frozenAt: '2026-03-15T00:00:00Z',
        messageCount: 3,
      },
    ];
    const p = createSessionProvider(readIndex as never);
    const res = await p.search('', 10);
    expect(res.map((r) => r.locator)).toEqual([
      '/sessions/new.md',
      '/sessions/mid.md',
      '/sessions/old.md',
    ]);
  });
});

describe('createScoopProvider', () => {
  it('lists non-cone scoops by name', async () => {
    const getScoops = () => [
      { jid: 'cone', name: 'sliccy', isCone: true },
      { jid: 'jid-1', name: 'andy-scoop', isCone: false },
    ];
    const p = createScoopProvider(getScoops as never);
    const res = await p.search('andy', 10);
    expect(res).toEqual([
      { kind: 'scoop', label: 'andy-scoop', sublabel: undefined, locator: 'jid-1' },
    ]);
  });
});

describe('createAggregator', () => {
  it('queries all providers and flattens results into one array', async () => {
    const itemA = {
      kind: 'file' as const,
      label: 'a.ts',
      sublabel: '/workspace',
      locator: '/workspace/a.ts',
    };
    const itemB = { kind: 'skill' as const, label: 'sprinkles', locator: 'sprinkles' };
    const providerA = { kind: 'file' as const, search: async () => [itemA] };
    const providerB = { kind: 'skill' as const, search: async () => [itemB] };
    const aggregator = createAggregator([providerA, providerB]);
    const results = await aggregator.search('', 10);
    expect(results).toContainEqual(itemA);
    expect(results).toContainEqual(itemB);
    expect(results).toHaveLength(2);
  });

  it('isolates provider errors — a throwing provider contributes [] and does not break others', async () => {
    const goodItem = {
      kind: 'file' as const,
      label: 'good.ts',
      sublabel: '/workspace',
      locator: '/workspace/good.ts',
    };
    const throwingProvider = {
      kind: 'skill' as const,
      search: async (): Promise<never> => {
        throw new Error('provider exploded');
      },
    };
    const goodProvider = { kind: 'file' as const, search: async () => [goodItem] };
    const aggregator = createAggregator([throwingProvider, goodProvider]);
    const results = await aggregator.search('', 10);
    expect(results).toContainEqual(goodItem);
    expect(results).toHaveLength(1);
  });
});
