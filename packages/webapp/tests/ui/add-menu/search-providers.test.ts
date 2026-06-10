import { describe, expect, it } from 'vitest';
import {
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
