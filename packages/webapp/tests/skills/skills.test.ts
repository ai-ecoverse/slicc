import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../../src/fs/index.js';
import {
  initSkillsSystem,
  readState,
  getAppliedSkills,
  discoverSkills,
  applySkill,
  uninstallSkill,
  readManifest,
  SLICC_DIR,
} from '../../src/skills/index.js';

const SKILLS_DIR = '/workspace/skills';

describe('Skills Engine', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    // Reset IndexedDB to get a clean state
    globalThis.indexedDB = new IDBFactory();
    // Create a fresh VirtualFS for each test
    fs = await VirtualFS.create();
  });

  afterEach(async () => {
    await fs.dispose();
  });

  describe('initSkillsSystem', () => {
    it('creates .slicc directory and state file', async () => {
      await initSkillsSystem(fs);

      const state = await readState(fs);
      expect(state.version).toBe('1.0.0');
      expect(state.applied_skills).toEqual([]);
    });

    it('is idempotent', async () => {
      await initSkillsSystem(fs);
      await initSkillsSystem(fs);

      const state = await readState(fs);
      expect(state.applied_skills).toEqual([]);
    });
  });

  describe('discoverSkills', () => {
    it('returns empty array when no skills exist', async () => {
      const skills = await discoverSkills(fs);
      expect(skills).toEqual([]);
    });

    it('discovers skills with manifest.yaml', async () => {
      // Create a skill
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/test-skill`);
      await fs.writeFile(
        `/workspace/skills/test-skill/manifest.yaml`,
        `skill: test-skill
version: 1.0.0
description: A test skill
adds:
  - test/file.txt
`
      );

      const skills = await discoverSkills(fs);
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('test-skill');
      expect(skills[0].manifest.version).toBe('1.0.0');
      expect(skills[0].installed).toBe(false);
    });

    it('discovers skills with SKILL.md only', async () => {
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/simple-skill`);
      await fs.writeFile(
        `/workspace/skills/simple-skill/SKILL.md`,
        '# Simple Skill\n\nInstructions here.'
      );

      const skills = await discoverSkills(fs);
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('simple-skill');
    });
  });

  describe('readManifest', () => {
    it('parses manifest.yaml correctly', async () => {
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/my-skill`);
      await fs.writeFile(
        `/workspace/skills/my-skill/manifest.yaml`,
        `skill: my-skill
version: 2.0.0
description: My awesome skill
adds:
  - src/feature.ts
  - src/feature.test.ts
modifies:
  - src/index.ts
depends:
  - base-skill
conflicts:
  - other-skill
`
      );

      const manifest = await readManifest(fs, `/workspace/skills/my-skill`);
      expect(manifest.skill).toBe('my-skill');
      expect(manifest.version).toBe('2.0.0');
      expect(manifest.description).toBe('My awesome skill');
      expect(manifest.adds).toEqual(['src/feature.ts', 'src/feature.test.ts']);
      expect(manifest.modifies).toEqual(['src/index.ts']);
      expect(manifest.depends).toEqual(['base-skill']);
      expect(manifest.conflicts).toEqual(['other-skill']);
    });
  });

  describe('applySkill', () => {
    it('installs a skill and copies files', async () => {
      // Set up skill
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/hello`);
      await fs.writeFile(
        `/workspace/skills/hello/manifest.yaml`,
        `skill: hello
version: 1.0.0
description: Hello world skill
adds:
  - hello.txt
`
      );
      await fs.mkdir(`/workspace/skills/hello/add`);
      await fs.writeFile(`/workspace/skills/hello/add/hello.txt`, 'Hello, world!');

      // Apply skill
      const result = await applySkill(fs, 'hello');
      expect(result.success).toBe(true);
      expect(result.skill).toBe('hello');
      expect(result.version).toBe('1.0.0');

      // Verify file was copied
      const content = await fs.readFile('/hello.txt');
      expect(content).toBe('Hello, world!');

      // Verify state was updated
      const appliedSkills = await getAppliedSkills(fs);
      expect(appliedSkills).toContain('hello');
    });

    it('fails if skill is already installed', async () => {
      // Set up and install skill
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/hello`);
      await fs.writeFile(
        `/workspace/skills/hello/manifest.yaml`,
        `skill: hello
version: 1.0.0
description: Hello world skill
`
      );

      await applySkill(fs, 'hello');
      const result = await applySkill(fs, 'hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already installed');
    });

    it('fails if dependencies are missing', async () => {
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/dependent`);
      await fs.writeFile(
        `/workspace/skills/dependent/manifest.yaml`,
        `skill: dependent
version: 1.0.0
description: Depends on base
depends:
  - base-skill
`
      );

      const result = await applySkill(fs, 'dependent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing dependencies');
      expect(result.error).toContain('base-skill');
    });

    it('fails if conflicting skill is installed', async () => {
      // Install first skill
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/skill-a`);
      await fs.writeFile(
        `/workspace/skills/skill-a/manifest.yaml`,
        `skill: skill-a
version: 1.0.0
description: Skill A
`
      );
      await applySkill(fs, 'skill-a');

      // Try to install conflicting skill
      await fs.mkdir(`/workspace/skills/skill-b`);
      await fs.writeFile(
        `/workspace/skills/skill-b/manifest.yaml`,
        `skill: skill-b
version: 1.0.0
description: Skill B conflicts with A
conflicts:
  - skill-a
`
      );

      const result = await applySkill(fs, 'skill-b');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Conflicting skills');
      expect(result.error).toContain('skill-a');
    });
  });

  describe('uninstallSkill', () => {
    it('removes installed skill files', async () => {
      // Set up and install skill
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/hello`);
      await fs.writeFile(
        `/workspace/skills/hello/manifest.yaml`,
        `skill: hello
version: 1.0.0
description: Hello world skill
adds:
  - hello.txt
`
      );
      await fs.mkdir(`/workspace/skills/hello/add`);
      await fs.writeFile(`/workspace/skills/hello/add/hello.txt`, 'Hello!');

      await applySkill(fs, 'hello');

      // Verify file exists
      const content = await fs.readFile('/hello.txt');
      expect(content).toBe('Hello!');

      // Uninstall
      const result = await uninstallSkill(fs, 'hello');
      expect(result.success).toBe(true);

      // Verify file was removed
      await expect(fs.readFile('/hello.txt')).rejects.toThrow();

      // Verify state was updated
      const appliedSkills = await getAppliedSkills(fs);
      expect(appliedSkills).not.toContain('hello');
    });

    it('fails if skill is not installed', async () => {
      const result = await uninstallSkill(fs, 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('fails if other skills depend on it', async () => {
      // Install base skill
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/base`);
      await fs.writeFile(
        `/workspace/skills/base/manifest.yaml`,
        `skill: base
version: 1.0.0
description: Base skill
`
      );
      await applySkill(fs, 'base');

      // Install dependent skill
      await fs.mkdir(`/workspace/skills/dependent`);
      await fs.writeFile(
        `/workspace/skills/dependent/manifest.yaml`,
        `skill: dependent
version: 1.0.0
description: Depends on base
depends:
  - base
`
      );
      await applySkill(fs, 'dependent');

      // Try to uninstall base
      const result = await uninstallSkill(fs, 'base');
      expect(result.success).toBe(false);
      expect(result.error).toContain('depends on');
    });
  });

  describe('security', () => {
    it('rejects path traversal in adds', async () => {
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/evil`);
      await fs.writeFile(
        `/workspace/skills/evil/manifest.yaml`,
        `skill: evil
version: 1.0.0
description: Evil skill with path traversal
adds:
  - ../../../etc/passwd
`
      );

      const result = await applySkill(fs, 'evil');
      expect(result.success).toBe(false);
      expect(result.error).toContain('traversal');
    });

    it('rejects absolute paths in adds', async () => {
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/evil`);
      await fs.writeFile(
        `/workspace/skills/evil/manifest.yaml`,
        `skill: evil
version: 1.0.0
description: Evil skill with absolute path
adds:
  - /etc/passwd
`
      );

      const result = await applySkill(fs, 'evil');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Absolute path');
    });

    it('enforces manifest.skill matches directory name', async () => {
      await fs.mkdir('/workspace/skills', { recursive: true });
      await fs.mkdir(`/workspace/skills/my-skill`);
      await fs.writeFile(
        `/workspace/skills/my-skill/manifest.yaml`,
        `skill: different-name
version: 1.0.0
description: Mismatched skill name
`
      );

      const result = await applySkill(fs, 'my-skill');
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not match');
    });
  });
});
