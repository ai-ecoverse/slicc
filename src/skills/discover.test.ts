import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../fs/index.js';
import {
  discoverSkills,
  getSkillInfo,
  readSkillInstructions,
} from './discover.js';
import { initSkillsSystem, recordSkillApplication } from './state.js';

const SKILLS_DIR = '/workspace/skills';

describe('discoverSkills', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    fs = await VirtualFS.create();
    await initSkillsSystem(fs);
  });

  it('finds skill with manifest.yaml', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/manifest-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/manifest-skill/manifest.yaml`,
      `skill: manifest-skill
version: 1.0.0
description: A skill with manifest`,
    );

    const skills = await discoverSkills(fs);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('manifest-skill');
    expect(skills[0].manifest.skill).toBe('manifest-skill');
    expect(skills[0].manifest.version).toBe('1.0.0');
    expect(skills[0].installed).toBe(false);
  });

  it('finds skill with only SKILL.md (no manifest)', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/md-only-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/md-only-skill/SKILL.md`,
      '# MD Only Skill\n\nThis is a skill with only instructions.',
    );

    const skills = await discoverSkills(fs);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('md-only-skill');
    expect(skills[0].manifest.skill).toBe('md-only-skill');
    expect(skills[0].installed).toBe(false);
  });

  it('skips directories without manifest or SKILL.md', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/empty-dir`);
    await fs.writeFile(`${SKILLS_DIR}/empty-dir/random.txt`, 'content');

    const skills = await discoverSkills(fs);
    expect(skills).toHaveLength(0);
  });

  it('returns empty array when skills dir missing', async () => {
    const skills = await discoverSkills(fs);
    expect(skills).toEqual([]);
  });

  it('marks installed skills correctly', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/installed-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/installed-skill/manifest.yaml`,
      `skill: installed-skill
version: 2.0.0
description: An installed skill`,
    );

    // Record the skill as installed
    await recordSkillApplication(fs, {
      name: 'installed-skill',
      version: '2.0.0',
      applied_at: new Date().toISOString(),
      file_hashes: {},
      added_files: [],
    });

    const skills = await discoverSkills(fs);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('installed-skill');
    expect(skills[0].installed).toBe(true);
    expect(skills[0].installedVersion).toBe('2.0.0');
  });

  it('discovers recursively reachable compatibility skills and surfaces source metadata', async () => {
    await fs.mkdir('/repo/.agents/skills/agent-skill', { recursive: true });
    await fs.writeFile(
      '/repo/.agents/skills/agent-skill/SKILL.md',
      '# Agent Skill\n\nCompatibility instructions.',
    );

    const skills = await discoverSkills(fs);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'agent-skill',
      source: 'agents',
      sourceRoot: '/repo/.agents/skills',
      path: '/repo/.agents/skills/agent-skill',
      skillFilePath: '/repo/.agents/skills/agent-skill/SKILL.md',
    });
  });

  it('uses native, then .agents, then .claude precedence and records shadowed paths', async () => {
    await fs.mkdir(`${SKILLS_DIR}/shared-skill`, { recursive: true });
    await fs.writeFile(`${SKILLS_DIR}/shared-skill/SKILL.md`, '# Native');

    await fs.mkdir('/z-repo/.agents/skills/shared-skill', { recursive: true });
    await fs.writeFile('/z-repo/.agents/skills/shared-skill/SKILL.md', '# Agent later');

    await fs.mkdir('/a-repo/.agents/skills/shared-skill', { recursive: true });
    await fs.writeFile('/a-repo/.agents/skills/shared-skill/SKILL.md', '# Agent first');

    await fs.mkdir('/repo/.claude/skills/shared-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/shared-skill/SKILL.md', '# Claude');

    const skills = await discoverSkills(fs);
    const sharedSkill = skills.find((skill) => skill.name === 'shared-skill');

    expect(sharedSkill).toMatchObject({
      source: 'native',
      path: '/workspace/skills/shared-skill',
      shadowedPaths: [
        '/a-repo/.agents/skills/shared-skill',
        '/z-repo/.agents/skills/shared-skill',
        '/repo/.claude/skills/shared-skill',
      ],
    });
  });
});

describe('getSkillInfo', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    fs = await VirtualFS.create();
    await initSkillsSystem(fs);
  });

  it('returns skill by name', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/test-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/test-skill/manifest.yaml`,
      `skill: test-skill
version: 1.5.0
description: Test skill`,
    );

    const skill = await getSkillInfo(fs, 'test-skill');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('test-skill');
    expect(skill!.manifest.version).toBe('1.5.0');
  });

  it('returns null for nonexistent skill', async () => {
    const skill = await getSkillInfo(fs, 'nonexistent');
    expect(skill).toBeNull();
  });

  it('returns the highest-precedence compatibility skill by name', async () => {
    await fs.mkdir('/repo/.claude/skills/external-only', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/external-only/SKILL.md', '# External only');

    const skill = await getSkillInfo(fs, 'external-only');

    expect(skill).toMatchObject({
      name: 'external-only',
      source: 'claude',
      path: '/repo/.claude/skills/external-only',
    });
  });
});

describe('readSkillInstructions', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    fs = await VirtualFS.create();
    await initSkillsSystem(fs);
  });

  it('returns SKILL.md content', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/documented-skill`);
    const instructions = '# Documented Skill\n\nUsage: do this and that.';
    await fs.writeFile(`${SKILLS_DIR}/documented-skill/SKILL.md`, instructions);

    const content = await readSkillInstructions(fs, 'documented-skill');
    expect(content).toBe(instructions);
  });

  it('returns null when no SKILL.md', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/no-docs-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/no-docs-skill/manifest.yaml`,
      `skill: no-docs-skill
version: 1.0.0
description: No docs`,
    );

    const content = await readSkillInstructions(fs, 'no-docs-skill');
    expect(content).toBeNull();
  });

  it('reads SKILL.md from a recursively discovered compatibility skill', async () => {
    await fs.mkdir('/repo/.claude/skills/compat-skill', { recursive: true });
    const instructions = '# Compat Skill\n\nUse from compatibility root.';
    await fs.writeFile('/repo/.claude/skills/compat-skill/SKILL.md', instructions);

    const content = await readSkillInstructions(fs, 'compat-skill');

    expect(content).toBe(instructions);
  });
});
