import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../../src/fs/index.js';
import { discoverSkillCandidates, resolveSkillNameCollisions } from '../../src/skills/catalog.js';

describe('discoverSkillCandidates', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    fs = await VirtualFS.create();
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

    expect(candidates.map((candidate) => ({
      source: candidate.source,
      path: candidate.path,
    }))).toEqual([
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
        .map((candidate) => candidate.path),
    ).toEqual([
      '/a-first/.agents/skills/duplicate',
      '/z-last/.agents/skills/duplicate',
    ]);
  });

  it('continues scanning until later reachable compatibility roots are visited', async () => {
    for (let index = 0; index < 10_000; index += 1) {
      await fs.mkdir(`/node-${index.toString().padStart(5, '0')}`, { recursive: true });
    }

    await fs.mkdir('/zz-after-cap/.claude/skills/late-skill', { recursive: true });
    await fs.writeFile('/zz-after-cap/.claude/skills/late-skill/SKILL.md', '# late');

    const candidates = await discoverSkillCandidates(fs);

    expect(candidates).toContainEqual(expect.objectContaining({
      source: 'claude',
      path: '/zz-after-cap/.claude/skills/late-skill',
    }));
  }, 10_000);

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
});

describe('resolveSkillNameCollisions', () => {
  it('keeps the first entry and records later entries as shadowed', () => {
    const { winners, collisions } = resolveSkillNameCollisions(
      [
        { name: 'shared', path: '/workspace/skills/shared' },
        { name: 'shared', path: '/repo/.agents/skills/shared' },
        { name: 'shared', path: '/repo/.claude/skills/shared' },
      ],
      (entry) => entry.name,
    );

    expect(winners).toEqual([
      { name: 'shared', path: '/workspace/skills/shared' },
    ]);
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