import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../../src/fs/index.js';
import { discoverSkills, getSkillInfo, readSkillInstructions } from '../../src/skills/discover.js';

const SKILLS_DIR = '/workspace/skills';

describe('discoverSkills', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    fs = await VirtualFS.create();
  });

  it('finds a skill with a SKILL.md file and uses the directory name', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/md-only-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/md-only-skill/SKILL.md`,
      '# MD Only Skill\n\nThis is a skill with only instructions.'
    );

    const skills = await discoverSkills(fs);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('md-only-skill');
    expect(skills[0].source).toBe('native');
  });

  it('parses the description from SKILL.md frontmatter when present', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/described`);
    await fs.writeFile(
      `${SKILLS_DIR}/described/SKILL.md`,
      '---\nname: described\ndescription: A skill with a frontmatter description.\n---\n# Body\n'
    );

    const skills = await discoverSkills(fs);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('A skill with a frontmatter description.');
  });

  it('parses frontmatter even with CRLF line endings, BOM, and leading blank lines', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/windows-skill`);
    // UTF-8 BOM + leading blank line + CRLF newlines
    const content =
      '\uFEFF\r\n---\r\nname: windows-skill\r\ndescription: Authored on Windows.\r\n---\r\n# Body\r\n';
    await fs.writeFile(`${SKILLS_DIR}/windows-skill/SKILL.md`, content);

    const skills = await discoverSkills(fs);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('Authored on Windows.');
  });

  it('skips directories without SKILL.md', async () => {
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

  it('discovers recursively reachable compatibility skills and surfaces source metadata', async () => {
    await fs.mkdir('/repo/.agents/skills/agent-skill', { recursive: true });
    await fs.writeFile(
      '/repo/.agents/skills/agent-skill/SKILL.md',
      '# Agent Skill\n\nCompatibility instructions.'
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
  });

  it('returns skill by name', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/test-skill`);
    await fs.writeFile(`${SKILLS_DIR}/test-skill/SKILL.md`, '# Test Skill\n');

    const skill = await getSkillInfo(fs, 'test-skill');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('test-skill');
    expect(skill!.skillFilePath).toBe(`${SKILLS_DIR}/test-skill/SKILL.md`);
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
  });

  it('returns SKILL.md content', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/documented-skill`);
    const instructions = '# Documented Skill\n\nUsage: do this and that.';
    await fs.writeFile(`${SKILLS_DIR}/documented-skill/SKILL.md`, instructions);

    const content = await readSkillInstructions(fs, 'documented-skill');
    expect(content).toBe(instructions);
  });

  it('returns null when no SKILL.md is present', async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/no-docs-skill`);
    await fs.writeFile(`${SKILLS_DIR}/no-docs-skill/notes.md`, '# Notes\n');

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
