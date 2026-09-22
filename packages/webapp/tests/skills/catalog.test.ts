import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { emptyPolicy } from '../../src/base/sudoers.js';
import { VirtualFS } from '../../src/fs/index.js';
import { createSudoFs, MONKEYPATCH_UNSAFE_FS } from '../../src/fs/sudo-fs.js';
import { discoverSkillCandidates, resolveSkillNameCollisions } from '../../src/skills/catalog.js';

describe('discoverSkillCandidates', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();

    fs = await VirtualFS.create({ wipe: true });
  });

  it('finds native, .agents, and .claude skill directories with stable precedence order', async () => {
    await fs.mkdir('/workspace/skills/native-skill', { recursive: true });
    await fs.writeFile('/workspace/skills/native-skill/SKILL.md', '# native');

    await fs.mkdir('/repo/tools/.agents/skills/agent-skill', { recursive: true });
    await fs.writeFile('/repo/tools/.agents/skills/agent-skill/SKILL.md', '# agent');

    await fs.mkdir('/repo/docs/.claude/skills/claude-skill', { recursive: true });
    await fs.writeFile('/repo/docs/.claude/skills/claude-skill/SKILL.md', '# claude');

    await fs.mkdir('/repo/ignored/.claude/skills/not-a-skill', { recursive: true });
    await fs.writeFile('/repo/ignored/.claude/skills/not-a-skill/README.md', 'ignore me');

    const candidates = await discoverSkillCandidates(fs);

    expect(
      candidates.map((candidate) => ({
        source: candidate.source,
        path: candidate.path,
      }))
    ).toEqual([
      { source: 'native', path: '/workspace/skills/native-skill' },
      { source: 'agents', path: '/repo/tools/.agents/skills/agent-skill' },
      { source: 'claude', path: '/repo/docs/.claude/skills/claude-skill' },
    ]);
  });

  it('uses lexicographic path order within the same compatibility source bucket', async () => {
    await fs.mkdir('/z-last/.agents/skills/duplicate', { recursive: true });
    await fs.writeFile('/z-last/.agents/skills/duplicate/SKILL.md', '# z');

    await fs.mkdir('/a-first/.agents/skills/duplicate', { recursive: true });
    await fs.writeFile('/a-first/.agents/skills/duplicate/SKILL.md', '# a');

    const candidates = await discoverSkillCandidates(fs);

    expect(
      candidates
        .filter((candidate) => candidate.source === 'agents')
        .map((candidate) => candidate.path)
    ).toEqual(['/a-first/.agents/skills/duplicate', '/z-last/.agents/skills/duplicate']);
  });

  it('continues scanning until later reachable compatibility roots are visited', async () => {
    for (let index = 0; index < 256; index += 1) {
      await fs.mkdir(`/node-${index.toString().padStart(5, '0')}`, { recursive: true });
    }

    await fs.mkdir('/zz-after-cap/.claude/skills/late-skill', { recursive: true });
    await fs.writeFile('/zz-after-cap/.claude/skills/late-skill/SKILL.md', '# late');

    const candidates = await discoverSkillCandidates(fs);

    expect(candidates).toContainEqual(
      expect.objectContaining({
        source: 'claude',
        path: '/zz-after-cap/.claude/skills/late-skill',
      })
    );
  });

  it('refreshes cached compatibility discovery after the same fs instance mutates', async () => {
    await fs.mkdir('/repo/.claude/skills/first-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/first-skill/SKILL.md', '# first');

    const initialCandidates = await discoverSkillCandidates(fs);
    expect(initialCandidates.map((candidate) => candidate.path)).toEqual([
      '/repo/.claude/skills/first-skill',
    ]);

    await fs.mkdir('/repo/tools/.agents/skills/second-skill', { recursive: true });
    await fs.writeFile('/repo/tools/.agents/skills/second-skill/SKILL.md', '# second');

    const refreshedCandidates = await discoverSkillCandidates(fs);
    expect(refreshedCandidates.map((candidate) => candidate.path)).toEqual([
      '/repo/tools/.agents/skills/second-skill',
      '/repo/.claude/skills/first-skill',
    ]);
  });

  it('prunes internal .slicc compatibility trees without skipping normal roots', async () => {
    await fs.mkdir('/.slicc/.claude/skills/hidden-skill', { recursive: true });
    await fs.writeFile('/.slicc/.claude/skills/hidden-skill/SKILL.md', '# hidden');

    await fs.mkdir('/repo/.claude/skills/visible-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/visible-skill/SKILL.md', '# visible');

    const candidates = await discoverSkillCandidates(fs);

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      '/repo/.claude/skills/visible-skill',
    ]);
  });

  it('discovers marketplace skills from a .claude-plugin/marketplace.json', async () => {
    const manifest = JSON.stringify({
      name: 'test-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [
        { name: 'my-tools', description: 'My tools', source: './plugins/my-tools', strict: false },
      ],
    });

    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/my-tools/skills/my-skill', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/my-tools/skills/my-skill/SKILL.md',
      '---\nname: my-skill\n---\n'
    );

    const candidates = await discoverSkillCandidates(fs);

    expect(candidates).toContainEqual(
      expect.objectContaining({
        source: 'marketplace',
        path: '/mnt/repo/plugins/my-tools/skills/my-skill',
      })
    );
  });

  it('sees a marketplace skill added after the compatibility cache filled', async () => {
    const manifest = JSON.stringify({
      name: 'test-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [
        { name: 'my-tools', description: 'My tools', source: './plugins/my-tools', strict: false },
      ],
    });
    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/my-tools/skills/my-skill', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/my-tools/skills/my-skill/SKILL.md',
      '---\nname: my-skill\n---\n'
    );
    await discoverSkillCandidates(fs);

    await fs.mkdir('/mnt/repo/plugins/my-tools/skills/new-skill', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/my-tools/skills/new-skill/SKILL.md',
      '---\nname: new-skill\n---\n'
    );

    const candidates = await discoverSkillCandidates(fs);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        source: 'marketplace',
        path: '/mnt/repo/plugins/my-tools/skills/new-skill',
      })
    );
  });

  it('skips marketplace plugins whose source is a git-subdir object', async () => {
    const manifest = JSON.stringify({
      name: 'test-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [
        { name: 'local-plugin', source: './plugins/local', strict: false },
        {
          name: 'external-plugin',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/org/repo',
            path: '.',
            sha: 'abc',
          },
          strict: false,
        },
      ],
    });

    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/local/skills/local-skill', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/local/skills/local-skill/SKILL.md',
      '---\nname: local-skill\n---\n'
    );

    const candidates = await discoverSkillCandidates(fs);
    const names = candidates.map((c) => c.path.split('/').pop());

    expect(names).toContain('local-skill');
    expect(candidates.filter((c) => c.source === 'marketplace')).toHaveLength(1);
  });

  it('discovers skills across multiple plugins in one manifest', async () => {
    const manifest = JSON.stringify({
      name: 'multi-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [
        { name: 'plugin-a', source: './plugins/a', strict: false },
        { name: 'plugin-b', source: './plugins/b', strict: false },
      ],
    });

    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/a/skills/skill-one', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/a/skills/skill-one/SKILL.md',
      '---\nname: skill-one\n---\n'
    );
    await fs.mkdir('/mnt/repo/plugins/b/skills/skill-two', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/b/skills/skill-two/SKILL.md',
      '---\nname: skill-two\n---\n'
    );

    const candidates = await discoverSkillCandidates(fs);
    const marketplaceCandidates = candidates.filter((c) => c.source === 'marketplace');

    expect(marketplaceCandidates.map((c) => c.path.split('/').pop()).sort()).toEqual([
      'skill-one',
      'skill-two',
    ]);
  });

  it('native skill shadows marketplace skill with the same name', async () => {
    const manifest = JSON.stringify({
      name: 'test-marketplace',
      metadata: { version: '1.0.0' },
      plugins: [{ name: 'my-tools', source: './plugins/my-tools', strict: false }],
    });

    await fs.mkdir('/workspace/skills/shared-name', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/shared-name/SKILL.md',
      '---\nname: shared-name\n---\n# native'
    );

    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
    await fs.mkdir('/mnt/repo/plugins/my-tools/skills/shared-name', { recursive: true });
    await fs.writeFile(
      '/mnt/repo/plugins/my-tools/skills/shared-name/SKILL.md',
      '---\nname: shared-name\n---\n# marketplace'
    );

    const candidates = await discoverSkillCandidates(fs);
    const { winners } = resolveSkillNameCollisions(
      candidates,
      (c) => c.path.split('/').pop() ?? ''
    );
    const winner = winners.find((w) => w.path.split('/').pop() === 'shared-name');

    expect(winner?.source).toBe('native');
  });

  it('ignores malformed marketplace.json without throwing', async () => {
    await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
    await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', 'not valid json {{{');

    const candidates = await discoverSkillCandidates(fs);
    expect(candidates.filter((c) => c.source === 'marketplace')).toHaveLength(0);
  });

  it('discovers skills when plugin source is repo root ("." or "./")', async () => {
    for (const source of ['.', './']) {
      globalThis.indexedDB = new IDBFactory();
      fs = await VirtualFS.create({ wipe: true });

      const manifest = JSON.stringify({
        name: 'root-source-marketplace',
        metadata: { version: '1.0.0' },
        plugins: [{ name: 'my-plugin', source, strict: false }],
      });

      await fs.mkdir('/mnt/repo/.claude-plugin', { recursive: true });
      await fs.writeFile('/mnt/repo/.claude-plugin/marketplace.json', manifest);
      await fs.mkdir('/mnt/repo/skills/root-skill', { recursive: true });
      await fs.writeFile('/mnt/repo/skills/root-skill/SKILL.md', '---\nname: root-skill\n---\n');

      const candidates = await discoverSkillCandidates(fs);
      const marketplace = candidates.filter((c) => c.source === 'marketplace');

      expect(marketplace).toHaveLength(1);
      expect(marketplace[0].path).toBe('/mnt/repo/skills/root-skill');
    }
  });

  it('discovers skills from installed agent plugins via /workspace/.plugins/plugins.json', async () => {
    await fs.mkdir('/workspace/my-plugin/skills/summarize', { recursive: true });
    await fs.writeFile(
      '/workspace/my-plugin/skills/summarize/SKILL.md',
      '---\nname: summarize\ndescription: d\n---\n'
    );
    await fs.mkdir('/workspace/.plugins', { recursive: true });
    await fs.writeFile(
      '/workspace/.plugins/plugins.json',
      JSON.stringify({ version: 1, plugins: { 'my-plugin': { root: '/workspace/my-plugin' } } })
    );

    const candidates = await discoverSkillCandidates(fs);
    const pluginCandidates = candidates.filter((c) => c.source === 'plugin');
    expect(pluginCandidates).toHaveLength(1);
    expect(pluginCandidates[0].path).toBe('/workspace/my-plugin/skills/summarize');
    expect(pluginCandidates[0].skillFilePath).toBe(
      '/workspace/my-plugin/skills/summarize/SKILL.md'
    );
  });

  it('ignores a malformed plugins.json registry without throwing', async () => {
    await fs.mkdir('/workspace/.plugins', { recursive: true });
    await fs.writeFile('/workspace/.plugins/plugins.json', 'not json {{{');

    const candidates = await discoverSkillCandidates(fs);
    expect(candidates.filter((c) => c.source === 'plugin')).toHaveLength(0);
  });

  it('plugin skills rank below native and compatibility sources in precedence order', async () => {
    await fs.mkdir('/workspace/skills/shared-name', { recursive: true });
    await fs.writeFile('/workspace/skills/shared-name/SKILL.md', '# native');
    await fs.mkdir('/workspace/my-plugin/skills/shared-name', { recursive: true });
    await fs.writeFile('/workspace/my-plugin/skills/shared-name/SKILL.md', '# plugin');
    await fs.mkdir('/workspace/.plugins', { recursive: true });
    await fs.writeFile(
      '/workspace/.plugins/plugins.json',
      JSON.stringify({ version: 1, plugins: { 'my-plugin': { root: '/workspace/my-plugin' } } })
    );

    const candidates = await discoverSkillCandidates(fs);
    const shared = candidates.filter((c) => c.path.endsWith('/shared-name'));
    expect(shared.map((c) => c.source)).toEqual(['native', 'plugin']);

    const { winners } = resolveSkillNameCollisions(shared, (c) => c.path.split('/').pop() ?? '');
    expect(winners[0].source).toBe('native');
  });

  it('terminates on a cyclic VFS (mount self-reference) instead of hanging, and still finds real skills', async () => {
    const tree: Record<string, Array<{ name: string; type: 'file' | 'directory' }>> = {
      '/': [
        { name: 'mnt', type: 'directory' },
        { name: 'repo', type: 'directory' },
        { name: 'workspace', type: 'directory' },
      ],
      '/workspace': [{ name: 'skills', type: 'directory' }],
      '/workspace/skills': [],
      '/repo': [{ name: '.claude', type: 'directory' }],
      '/repo/.claude': [{ name: 'skills', type: 'directory' }],
      '/repo/.claude/skills': [{ name: 'real', type: 'directory' }],
      '/repo/.claude/skills/real': [{ name: 'SKILL.md', type: 'file' }],
      '/mnt': [{ name: 'loop', type: 'directory' }],
    };

    const isCycle = (path: string): boolean => /^\/mnt(\/loop)+$/.test(path);
    const cyclicFs = {
      readDir: async (path: string) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (isCycle(path)) return [{ name: 'loop', type: 'directory' as const }];
        return tree[path] ?? [];
      },
      stat: async (path: string) => {
        if (path === '/repo/.claude/skills/real/SKILL.md') {
          return { type: 'file' as const, size: 0, mtime: 0 };
        }
        if (path === '/mnt' || isCycle(path) || tree[path]) {
          return { type: 'directory' as const, size: 0, mtime: 0 };
        }
        throw new Error(`ENOENT: ${path}`);
      },
      readTextFile: async (path: string) => {
        if (path === '/repo/.claude/skills/real/SKILL.md') return '---\nname: real\n---\n';
        throw new Error(`ENOENT: ${path}`);
      },
    } as unknown as VirtualFS;

    const candidates = await discoverSkillCandidates(cyclicFs);

    expect(candidates.map((candidate) => candidate.path)).toContain('/repo/.claude/skills/real');
  }, 8000);

  it('shares one compatibility walk across overlapping discoveries', async () => {
    await fs.mkdir('/repo/.claude/skills/first-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/first-skill/SKILL.md', '# first');

    let rootReads = 0;
    const readDir = fs.readDir.bind(fs);
    vi.spyOn(fs, 'readDir').mockImplementation(async (path: string) => {
      if (path === '/') rootReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return readDir(path);
    });

    const [first, second] = await Promise.all([
      discoverSkillCandidates(fs),
      discoverSkillCandidates(fs),
    ]);

    expect(first.map((candidate) => candidate.path)).toEqual(
      second.map((candidate) => candidate.path)
    );
    expect(first.map((candidate) => candidate.path)).toContain('/repo/.claude/skills/first-skill');
    expect(rootReads).toBe(1);
  });

  it('keeps the compatibility cache across scoop-skeleton mkdirs and drops it on rm', async () => {
    await fs.mkdir('/repo/.claude/skills/first-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/first-skill/SKILL.md', '# first');
    await discoverSkillCandidates(fs);

    let rootReads = 0;
    const readDir = fs.readDir.bind(fs);
    vi.spyOn(fs, 'readDir').mockImplementation(async (path: string) => {
      if (path === '/') rootReads += 1;
      return readDir(path);
    });

    await fs.mkdir('/scoops/child/workspace', { recursive: true });
    await fs.mkdir('/scoops/child/tmp', { recursive: true });
    await fs.mkdir('/shared', { recursive: true });
    await fs.writeFile('/scoops/child/workspace/CLAUDE.md', '# memory');

    const cached = await discoverSkillCandidates(fs);
    expect(cached.map((candidate) => candidate.path)).toEqual(['/repo/.claude/skills/first-skill']);
    expect(rootReads).toBe(0);

    await fs.rm('/repo', { recursive: true });
    const afterRemove = await discoverSkillCandidates(fs);
    expect(afterRemove.map((candidate) => candidate.path)).toEqual([]);
    expect(rootReads).toBe(1);
  });

  it('does not drop the compatibility cache when file contents mention a compatibility path', async () => {
    await fs.mkdir('/repo/.claude/skills/first-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/first-skill/SKILL.md', '# first');
    await discoverSkillCandidates(fs);

    let rootReads = 0;
    const readDir = fs.readDir.bind(fs);
    vi.spyOn(fs, 'readDir').mockImplementation(async (path: string) => {
      if (path === '/') rootReads += 1;
      return readDir(path);
    });

    await fs.mkdir('/notes', { recursive: true });
    await fs.writeFile(
      '/notes/readme.md',
      'see /.claude/skills/not-real/SKILL.md and .agents/skills'
    );

    const cached = await discoverSkillCandidates(fs);
    expect(cached.map((candidate) => candidate.path)).toEqual(['/repo/.claude/skills/first-skill']);
    expect(rootReads).toBe(0);
  });
});

describe('discoverSkillCandidates over a sudo-fs Proxy (OOM regression)', () => {
  let raw: VirtualFS;
  let gated: VirtualFS;

  const noopBroker = {
    async requestApproval() {
      return { decision: 'allow' as const };
    },
  };

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    raw = await VirtualFS.create({ wipe: true });

    gated = createSudoFs(raw, { broker: noopBroker, getPolicy: () => emptyPolicy() });
  });

  it('advertises the monkeypatch-unsafe marker', () => {
    expect((gated as unknown as Record<symbol, unknown>)[MONKEYPATCH_UNSAFE_FS]).toBe(true);
    expect((raw as unknown as Record<symbol, unknown>)[MONKEYPATCH_UNSAFE_FS]).toBeUndefined();
  });

  it('does NOT monkeypatch the wrapped target (the override↔hook recursion that OOMed the worker)', async () => {
    await raw.mkdir('/workspace/.claude/skills/foo', { recursive: true });
    await raw.writeFile('/workspace/.claude/skills/foo/SKILL.md', '# foo');

    const before = {
      writeFile: raw.writeFile,
      mkdir: raw.mkdir,
      rm: raw.rm,
    };

    const candidates = await discoverSkillCandidates(gated);

    expect(candidates.map((c) => c.path)).toContain('/workspace/.claude/skills/foo');

    expect(raw.writeFile).toBe(before.writeFile);
    expect(raw.mkdir).toBe(before.mkdir);
    expect(raw.rm).toBe(before.rm);

    let realWriteCalls = 0;
    const realWrite = raw.writeFile.bind(raw);
    raw.writeFile = (async (path: string, content: string | Uint8Array) => {
      realWriteCalls += 1;
      return realWrite(path, content);
    }) as typeof raw.writeFile;
    await gated.writeFile('/tmp/probe.txt', 'ok');
    expect(realWriteCalls).toBe(1);
    expect(await raw.readTextFile('/tmp/probe.txt')).toBe('ok');
  });

  it('returns the same candidates whether discovery runs over the raw fs or the gated Proxy', async () => {
    await raw.mkdir('/repo/.agents/skills/agent-skill', { recursive: true });
    await raw.writeFile('/repo/.agents/skills/agent-skill/SKILL.md', '# agent');
    await raw.mkdir('/workspace/skills/native-skill', { recursive: true });
    await raw.writeFile('/workspace/skills/native-skill/SKILL.md', '# native');

    const overRaw = (await discoverSkillCandidates(raw)).map((c) => c.path);
    const overGated = (await discoverSkillCandidates(gated)).map((c) => c.path);

    expect(overGated).toEqual(overRaw);
  });
});

describe('resolveSkillNameCollisions', () => {
  it('keeps the first entry and records later entries as shadowed', () => {
    const { winners, collisions } = resolveSkillNameCollisions(
      [
        { name: 'shared', path: '/workspace/skills/shared' },
        { name: 'shared', path: '/repo/.agents/skills/shared' },
        { name: 'shared', path: '/repo/.claude/skills/shared' },
      ],
      (entry) => entry.name
    );

    expect(winners).toEqual([{ name: 'shared', path: '/workspace/skills/shared' }]);
    expect(collisions).toEqual([
      {
        name: 'shared',
        winner: { name: 'shared', path: '/workspace/skills/shared' },
        shadowed: [
          { name: 'shared', path: '/repo/.agents/skills/shared' },
          { name: 'shared', path: '/repo/.claude/skills/shared' },
        ],
      },
    ]);
  });
});
