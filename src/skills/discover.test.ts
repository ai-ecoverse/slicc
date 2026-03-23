import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../fs/index.js';
import { discoverSkills, getSkillInfo, readSkillInstructions } from './discover.js';
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
description: A skill with manifest`
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
      '# MD Only Skill\n\nThis is a skill with only instructions.'
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
description: An installed skill`
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
description: Test skill`
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
description: No docs`
    );

    const content = await readSkillInstructions(fs, 'no-docs-skill');
    expect(content).toBeNull();
  });
});
