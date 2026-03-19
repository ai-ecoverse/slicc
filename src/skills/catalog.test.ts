import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../fs/index.js';
import { discoverSkillCandidates, resolveSkillNameCollisions } from './catalog.js';

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