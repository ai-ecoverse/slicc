/**
 * Tests for the skills system — frontmatter parsing, loading, and prompt formatting.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../fs/virtual-fs.js';
import { loadSkills, formatSkillsForPrompt } from './skills.js';

describe('Skills', () => {
  let vfs: VirtualFS;

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-skills', wipe: true });
  });

  describe('loadSkills', () => {
    it('loads a skill from a subdirectory with SKILL.md', async () => {
      await vfs.mkdir('/skills/browser', { recursive: true });
      await vfs.writeFile('/skills/browser/SKILL.md', `---
name: browser
description: Browse the web
allowed-tools: browser, screenshot
---

# Browser Skill

Use the browser tool to navigate pages.
`);
      const skills = await loadSkills(vfs, '/skills');
      expect(skills).toHaveLength(1);
      expect(skills[0].metadata.name).toBe('browser');
      expect(skills[0].metadata.description).toBe('Browse the web');
      expect(skills[0].metadata.allowedTools).toEqual(['browser', 'screenshot']);
      expect(skills[0].content).toContain('# Browser Skill');
    });

    it('loads a standalone .md skill file', async () => {
      await vfs.mkdir('/skills2', { recursive: true });
      await vfs.writeFile('/skills2/coding.md', `---
name: coding
description: Write code
---

Write clean code.
`);
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
      await vfs.writeFile('/skills4/a/SKILL.md', '---\nname: alpha\ndescription: first\n---\nAlpha content');
      await vfs.writeFile('/skills4/b/SKILL.md', '---\nname: beta\ndescription: second\n---\nBeta content');

      const skills = await loadSkills(vfs, '/skills4');
      expect(skills).toHaveLength(2);
      const names = skills.map(s => s.metadata.name).sort();
      expect(names).toEqual(['alpha', 'beta']);
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
      const result = formatSkillsForPrompt([{
        metadata: { name: 'test', description: 'A test skill' },
        content: 'Do the thing.',
        path: '/skills/test/SKILL.md',
      }]);
      expect(result).toContain('AVAILABLE SKILLS');
      expect(result).toContain('**test**');
      expect(result).toContain('A test skill');
      expect(result).toContain('Path: /skills/test/SKILL.md');
      expect(result).toContain('read_file');
      // Should NOT include full content
      expect(result).not.toContain('Do the thing.');
    });

    it('includes allowed tools when present', () => {
      const result = formatSkillsForPrompt([{
        metadata: { name: 'browser', description: 'Browse', allowedTools: ['browser', 'screenshot'] },
        content: 'Content',
        path: '/skills/browser/SKILL.md',
      }]);
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
});
