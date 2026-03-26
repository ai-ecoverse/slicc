/**
 * Tests for the skills system — frontmatter parsing, loading, and prompt formatting.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { loadSkills, formatSkillsForPrompt } from '../../src/scoops/skills.js';

describe('Skills', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-skills-${dbCounter++}`, wipe: true });
  });

  describe('loadSkills', () => {
    it('loads a skill from a subdirectory with SKILL.md', async () => {
      await vfs.mkdir('/skills/browser', { recursive: true });
      await vfs.writeFile(
        '/skills/browser/SKILL.md',
        `---
name: browser
description: Browse the web
allowed-tools: bash
---

# Browser Skill

Use the playwright-cli shell command via bash to navigate pages.
`
      );
      const skills = await loadSkills(vfs, '/skills');
      expect(skills).toHaveLength(1);
      expect(skills[0].metadata.name).toBe('browser');
      expect(skills[0].metadata.description).toBe('Browse the web');
      expect(skills[0].metadata.allowedTools).toEqual(['bash']);
      expect(skills[0].content).toContain('# Browser Skill');
      expect(skills[0].path).toBe('/skills/browser/SKILL.md');
    });

    it('loads a standalone .md skill file', async () => {
      await vfs.mkdir('/skills2', { recursive: true });
      await vfs.writeFile(
        '/skills2/coding.md',
        `---
name: coding
description: Write code
---

Write clean code.
`
      );
      const skills = await loadSkills(vfs, '/skills2');
      expect(skills).toHaveLength(1);
      expect(skills[0].metadata.name).toBe('coding');
      expect(skills[0].content).toContain('Write clean code.');
    });

    it('uses filename as name when frontmatter has no name', async () => {
      await vfs.mkdir('/skills3', { recursive: true });
      await vfs.writeFile('/skills3/unnamed.md', 'Just some content without frontmatter.');

      const skills = await loadSkills(vfs, '/skills3');
      expect(skills).toHaveLength(1);
      expect(skills[0].metadata.name).toBe('unnamed');
      expect(skills[0].content).toBe('Just some content without frontmatter.');
    });

    it('returns empty array for non-existent directory', async () => {
      const skills = await loadSkills(vfs, '/nonexistent-skills');
      expect(skills).toEqual([]);
    });

    it('loads multiple skills', async () => {
      await vfs.mkdir('/skills4/a', { recursive: true });
      await vfs.mkdir('/skills4/b', { recursive: true });
      await vfs.writeFile(
        '/skills4/a/SKILL.md',
        '---\nname: alpha\ndescription: first\n---\nAlpha content'
      );
      await vfs.writeFile(
        '/skills4/b/SKILL.md',
        '---\nname: beta\ndescription: second\n---\nBeta content'
      );

      const skills = await loadSkills(vfs, '/skills4');
      expect(skills).toHaveLength(2);
      const names = skills.map((s) => s.metadata.name).sort();
      expect(names).toEqual(['alpha', 'beta']);
    });

    it('loads recursively discovered compatibility skills without frontmatter', async () => {
      await vfs.mkdir('/repo/.claude/skills/compat-skill', { recursive: true });
      await vfs.writeFile(
        '/repo/.claude/skills/compat-skill/SKILL.md',
        '# Compat Skill\n\nUse this compatibility skill.'
      );

      const skills = await loadSkills(vfs, '/workspace/skills');

      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        metadata: {
          name: 'compat-skill',
          description: 'Skill from compat-skill',
        },
        path: '/repo/.claude/skills/compat-skill/SKILL.md',
      });
      expect(skills[0].content).toContain('Use this compatibility skill.');
    });

    it('uses unified discovery precedence for duplicate discovered skill names', async () => {
      await vfs.mkdir('/workspace/skills/shared-skill', { recursive: true });
      await vfs.writeFile('/workspace/skills/shared-skill/SKILL.md', '# Native');

      await vfs.mkdir('/repo/.agents/skills/shared-skill', { recursive: true });
      await vfs.writeFile('/repo/.agents/skills/shared-skill/SKILL.md', '# Agent');

      await vfs.mkdir('/repo/.claude/skills/shared-skill', { recursive: true });
      await vfs.writeFile('/repo/.claude/skills/shared-skill/SKILL.md', '# Claude');

      const skills = await loadSkills(vfs, '/workspace/skills');
      const sharedSkills = skills.filter((skill) => skill.metadata.name === 'shared-skill');

      expect(sharedSkills).toHaveLength(1);
      expect(sharedSkills[0].path).toBe('/workspace/skills/shared-skill/SKILL.md');
      expect(sharedSkills[0].content).toContain('# Native');
    });

    it('preserves standalone native markdown skills alongside discovered compatibility skills', async () => {
      await vfs.mkdir('/workspace/skills', { recursive: true });
      await vfs.writeFile('/workspace/skills/legacy.md', 'Legacy instructions.');

      await vfs.mkdir('/repo/.agents/skills/compat-skill', { recursive: true });
      await vfs.writeFile('/repo/.agents/skills/compat-skill/SKILL.md', '# Compat');

      const skills = await loadSkills(vfs, '/workspace/skills');
      const names = skills.map((skill) => skill.metadata.name).sort();

      expect(names).toEqual(['compat-skill', 'legacy']);
      expect(skills.find((skill) => skill.metadata.name === 'legacy')?.path).toBe(
        '/workspace/skills/legacy.md'
      );
    });

    it('keeps standalone native markdown skills ahead of compatibility duplicates', async () => {
      await vfs.mkdir('/workspace/skills', { recursive: true });
      await vfs.writeFile('/workspace/skills/shared-skill.md', '# Native standalone');

      await vfs.mkdir('/repo/.agents/skills/shared-skill', { recursive: true });
      await vfs.writeFile('/repo/.agents/skills/shared-skill/SKILL.md', '# Agent');

      await vfs.mkdir('/repo/.claude/skills/shared-skill', { recursive: true });
      await vfs.writeFile('/repo/.claude/skills/shared-skill/SKILL.md', '# Claude');

      const skills = await loadSkills(vfs, '/workspace/skills');
      const sharedSkills = skills.filter((skill) => skill.metadata.name === 'shared-skill');

      expect(sharedSkills).toHaveLength(1);
      expect(sharedSkills[0].path).toBe('/workspace/skills/shared-skill.md');
      expect(sharedSkills[0].content).toContain('# Native standalone');
    });

    it('skips subdirectories without SKILL.md', async () => {
      await vfs.mkdir('/skills5/empty-dir', { recursive: true });
      await vfs.writeFile('/skills5/empty-dir/readme.txt', 'not a skill');

      const skills = await loadSkills(vfs, '/skills5');
      expect(skills).toEqual([]);
    });
  });

  describe('formatSkillsForPrompt', () => {
    it('returns empty string for no skills', () => {
      expect(formatSkillsForPrompt([])).toBe('');
    });

    it('formats skill header with path for on-demand reading', () => {
      const result = formatSkillsForPrompt([
        {
          metadata: { name: 'test', description: 'A test skill' },
          content: 'Do the thing.',
          path: '/skills/test/SKILL.md',
        },
      ]);
      expect(result).toContain('AVAILABLE SKILLS');
      expect(result).toContain('**test**');
      expect(result).toContain('A test skill');
      expect(result).toContain('Path: /skills/test/SKILL.md');
      expect(result).toContain('read_file');
      // Should NOT include full content
      expect(result).not.toContain('Do the thing.');
    });

    it('includes allowed tools when present', () => {
      const result = formatSkillsForPrompt([
        {
          metadata: {
            name: 'browser',
            description: 'Browse',
            allowedTools: ['browser', 'screenshot'],
          },
          content: 'Content',
          path: '/skills/browser/SKILL.md',
        },
      ]);
      expect(result).toContain('Allowed tools: browser, screenshot');
    });

    it('formats multiple skills as a list', () => {
      const result = formatSkillsForPrompt([
        { metadata: { name: 'a', description: 'A' }, content: 'A content', path: '/a' },
        { metadata: { name: 'b', description: 'B' }, content: 'B content', path: '/b' },
      ]);
      expect(result).toContain('**a**');
      expect(result).toContain('**b**');
      expect(result).toContain('Path: /a');
      expect(result).toContain('Path: /b');
    });
  });

  describe('scoop skill visibility via skillsFs', () => {
    it('loads cone-installed skills when given unrestricted FS', async () => {
      const sharedFs = await VirtualFS.create({
        dbName: `test-scoop-visibility-${dbCounter++}`,
        wipe: true,
      });

      // Simulate upskill installing a skill to cone's directory
      await sharedFs.mkdir('/workspace/skills/migrations', { recursive: true });
      await sharedFs.writeFile(
        '/workspace/skills/migrations/SKILL.md',
        '---\nname: migrations\ndescription: Migrate pages\n---\nMigration instructions.'
      );

      // Load skills from /workspace/skills/ using the unrestricted FS
      // (this is what scoops will do after the fix)
      const skills = await loadSkills(sharedFs, '/workspace/skills');

      expect(skills.some((s) => s.metadata.name === 'migrations')).toBe(true);
    });

    it('RestrictedFS cannot reach /workspace/skills/', async () => {
      const { RestrictedFS } = await import('../../src/fs/restricted-fs.js');
      const sharedFs = await VirtualFS.create({
        dbName: `test-scoop-restricted-${dbCounter++}`,
        wipe: true,
      });

      await sharedFs.mkdir('/workspace/skills/test-skill', { recursive: true });
      await sharedFs.writeFile(
        '/workspace/skills/test-skill/SKILL.md',
        '---\nname: test-skill\ndescription: Test\n---\nTest.'
      );

      // Scoop's RestrictedFS blocks /workspace/
      const restrictedFs = new RestrictedFS(sharedFs, ['/scoops/my-scoop/', '/shared/']);
      const skills = await loadSkills(
        restrictedFs as unknown as VirtualFS,
        '/workspace/skills'
      );

      // Should find nothing — confirming the problem this fix addresses
      expect(skills).toHaveLength(0);
    });
  });
});
