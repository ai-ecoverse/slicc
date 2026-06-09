import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../../src/fs/index.js';
import { discoverSkillCandidates, resolveSkillNameCollisions } from '../../src/skills/catalog.js';

describe('discoverSkillCandidates', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    // VirtualFS' memory backend caches stores per dbName so multiple
    // alive instances share state. Pass `wipe: true` here so each
    // test starts with a clean tree (the prior LightningFS path
    // relied on `new IDBFactory()` for the same effect).
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
    // The historical `MAX_DISCOVERY_DIRECTORIES = 10_000` cap in catalog.ts
    // was removed in d14f81c6; today the BFS walks the whole tree. The
    // test now only needs to prove the queue does not stop early between
    // an early lexicographic neighbour and a late `.claude` root. A
    // modest synthetic count exercises the BFS past several pump rounds
    // without spending 25-30s on ZenFS InMemory mkdir under Node 24/25.
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
