import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { initFeatureFlags, setFeatureFlagOverride } from '../../src/core/feature-flags.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  createDefaultSharedFiles,
  createDefaultSkills,
  formatSkillsForPrompt,
  loadSkills,
} from '../../src/scoops/skills.js';

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

    it('loads literal and folded block-scalar descriptions into the prompt list', async () => {
      await vfs.mkdir('/skills/block-lit', { recursive: true });
      await vfs.mkdir('/skills/block-fold', { recursive: true });
      await vfs.writeFile(
        '/skills/block-lit/SKILL.md',
        '---\nname: block-lit\ndescription: |\n  First line\n  Second line\n---\n# Lit\n'
      );
      await vfs.writeFile(
        '/skills/block-fold/SKILL.md',
        '---\nname: block-fold\ndescription: >\n  Folded A\n  Folded B\n---\n# Fold\n'
      );

      const skills = await loadSkills(vfs, '/skills');
      const byName = Object.fromEntries(
        skills.map((s) => [s.metadata.name, s.metadata.description])
      );
      expect(byName['block-lit']).toBe('First line\nSecond line');
      expect(byName['block-fold']).toBe('Folded A Folded B');

      const prompt = formatSkillsForPrompt(skills);
      expect(prompt).toContain('First line');
      expect(prompt).not.toMatch(/\*\*block-lit\*\*: \|/);
      expect(prompt).not.toMatch(/\*\*block-fold\*\*: >/);
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
          description: '',
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

      await sharedFs.mkdir('/workspace/skills/migrations', { recursive: true });
      await sharedFs.writeFile(
        '/workspace/skills/migrations/SKILL.md',
        '---\nname: migrations\ndescription: Migrate pages\n---\nMigration instructions.'
      );

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

      const restrictedFs = new RestrictedFS(sharedFs, ['/scoops/my-scoop/', '/shared/']);
      const skills = await loadSkills(restrictedFs as unknown as VirtualFS, '/workspace/skills');

      expect(skills).toHaveLength(0);
    });
  });
});

describe('no-default-skills', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, String(value)),
      removeItem: (key) => void values.delete(key),
      clear: () => values.clear(),
      key: (index) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    } as Storage;
  }

  beforeEach(async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    initFeatureFlags('standalone');
    vfs = await VirtualFS.create({ dbName: `test-no-default-skills-${dbCounter++}`, wipe: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('seeds bundled skills when the flag is off, and the prompt lists them', async () => {
    await createDefaultSkills(vfs);
    const skills = await loadSkills(vfs, '/workspace/skills');
    const prompt = formatSkillsForPrompt(skills);
    expect(skills.some((skill) => skill.metadata.name === 'playwright-cli')).toBe(true);
    expect(prompt).toContain('playwright-cli');
    expect(prompt).toContain('/workspace/skills/playwright-cli/SKILL.md');
  });

  it('does not seed bundled skills when the flag is on, and the prompt lists only what is on disk', async () => {
    setFeatureFlagOverride('no-default-skills', 'on');
    await vfs.mkdir('/workspace/skills/custom', { recursive: true });
    await vfs.writeFile(
      '/workspace/skills/custom/SKILL.md',
      '---\nname: custom\ndescription: Already here\n---\nKeep me.\n'
    );

    await createDefaultSkills(vfs);
    await createDefaultSharedFiles(vfs);

    await expect(vfs.stat('/workspace/skills/playwright-cli/SKILL.md')).rejects.toThrow();
    await expect(vfs.stat('/shared/CLAUDE.md')).resolves.toBeTruthy();

    const skills = await loadSkills(vfs, '/workspace/skills');
    expect(skills.map((skill) => skill.metadata.name)).toEqual(['custom']);
    const prompt = formatSkillsForPrompt(skills);
    expect(prompt).toContain('**custom**');
    expect(prompt).not.toContain('playwright-cli');
  });

  describe('createDefaultSharedFiles', () => {
    it('seeds /shared/CLAUDE.md when it is absent', async () => {
      await createDefaultSharedFiles(vfs);
      await expect(vfs.stat('/shared/CLAUDE.md')).resolves.toBeTruthy();
    });

    it('keeps existing /shared/CLAUDE.md when stat succeeds', async () => {
      await vfs.mkdir('/shared', { recursive: true });
      await vfs.writeFile('/shared/CLAUDE.md', 'my durable memory');
      await createDefaultSharedFiles(vfs);
      expect(await vfs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' })).toBe(
        'my durable memory'
      );
    });

    it('does not clobber /shared/CLAUDE.md on a non-ENOENT stat fault', async () => {
      await vfs.mkdir('/shared', { recursive: true });
      await vfs.writeFile('/shared/CLAUDE.md', 'my durable memory');
      const realStat = vfs.stat.bind(vfs);
      const spy = vi.spyOn(vfs, 'stat').mockImplementation(async (path: string) => {
        if (path === '/shared/CLAUDE.md') {
          throw Object.assign(new Error('transient store fault'), { code: 'EIO' });
        }
        return realStat(path);
      });
      await createDefaultSharedFiles(vfs);
      spy.mockRestore();
      expect(await vfs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' })).toBe(
        'my durable memory'
      );
    });

    it('does not clobber when a structured non-ENOENT error mentions ENOENT in its message', async () => {
      await vfs.mkdir('/shared', { recursive: true });
      await vfs.writeFile('/shared/CLAUDE.md', 'my durable memory');
      const realStat = vfs.stat.bind(vfs);
      const spy = vi.spyOn(vfs, 'stat').mockImplementation(async (path: string) => {
        if (path === '/shared/CLAUDE.md') {
          throw Object.assign(new Error('EIO while resolving (not ENOENT)'), { code: 'EIO' });
        }
        return realStat(path);
      });
      await createDefaultSharedFiles(vfs);
      spy.mockRestore();
      expect(await vfs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' })).toBe(
        'my durable memory'
      );
    });
  });
});
