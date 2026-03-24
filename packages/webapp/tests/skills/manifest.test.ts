import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../../src/fs/index.js';
import {
  parseManifestContent,
  readManifest,
  checkDependencies,
  checkConflicts,
} from '../../src/skills/manifest.js';

describe('Manifest', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    fs = await VirtualFS.create();
  });

  describe('parseManifestContent', () => {
    it('parses valid manifest with all fields', () => {
      const content = `skill: my-skill
version: 1.0.0
description: A test skill
author: Test Author
adds:
  - file1.txt
  - file2.txt
modifies:
  - file3.txt
depends:
  - dep-skill
conflicts:
  - conflict-skill
test: npm test`;

      const manifest = parseManifestContent(content);

      expect(manifest.skill).toBe('my-skill');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.description).toBe('A test skill');
      expect(manifest.author).toBe('Test Author');
      expect(manifest.adds).toEqual(['file1.txt', 'file2.txt']);
      expect(manifest.modifies).toEqual(['file3.txt']);
      expect(manifest.depends).toEqual(['dep-skill']);
      expect(manifest.conflicts).toEqual(['conflict-skill']);
      expect(manifest.test).toBe('npm test');
    });

    it('parses minimal manifest with only required fields', () => {
      const content = `skill: minimal-skill
version: 0.1.0`;

      const manifest = parseManifestContent(content);

      expect(manifest.skill).toBe('minimal-skill');
      expect(manifest.version).toBe('0.1.0');
      expect(manifest.description).toBe('');
      expect(manifest.adds).toEqual([]);
      expect(manifest.modifies).toEqual([]);
      expect(manifest.depends).toEqual([]);
      expect(manifest.conflicts).toEqual([]);
      expect(manifest.test).toBeUndefined();
      expect(manifest.author).toBeUndefined();
    });

    it('throws on missing skill field', () => {
      const content = `version: 1.0.0
description: No skill field`;

      expect(() => parseManifestContent(content)).toThrow(
        "Invalid manifest: missing 'skill' field"
      );
    });

    it('throws on missing version field', () => {
      const content = `skill: no-version-skill
description: Missing version`;

      expect(() => parseManifestContent(content)).toThrow(
        "Invalid manifest: missing 'version' field"
      );
    });

    it('handles multiple array types', () => {
      const content = `skill: multi-array
version: 1.0.0
adds:
  - src/file1.ts
  - src/file2.ts
modifies:
  - README.md
  - package.json
depends:
  - dep1
  - dep2
  - dep3
conflicts:
  - conflict1`;

      const manifest = parseManifestContent(content);

      expect(manifest.adds).toEqual(['src/file1.ts', 'src/file2.ts']);
      expect(manifest.modifies).toEqual(['README.md', 'package.json']);
      expect(manifest.depends).toEqual(['dep1', 'dep2', 'dep3']);
      expect(manifest.conflicts).toEqual(['conflict1']);
    });

    it('ignores line comments in YAML', () => {
      const content = `# This is a comment
skill: commented-skill
# Another comment
version: 1.0.0
# description comment
description: A skill with comments
adds:
  - file1.txt
  # - file2.txt (commented out)
  - file3.txt`;

      const manifest = parseManifestContent(content);

      expect(manifest.skill).toBe('commented-skill');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.description).toBe('A skill with comments');
      expect(manifest.adds).toEqual(['file1.txt', 'file3.txt']);
    });

    it('handles empty arrays', () => {
      const content = `skill: empty-arrays
version: 1.0.0
adds: []
modifies: []`;

      const manifest = parseManifestContent(content);

      expect(manifest.adds).toEqual([]);
      expect(manifest.modifies).toEqual([]);
    });

    it('includes custom manifestPath in error message', () => {
      const content = `version: 1.0.0`;

      expect(() =>
        parseManifestContent(content, '/workspace/skills/test-skill/manifest.yaml')
      ).toThrow(
        "Invalid manifest: missing 'skill' field in /workspace/skills/test-skill/manifest.yaml"
      );
    });

    it('handles structured section', () => {
      const content = `skill: structured-skill
version: 1.0.0
structured:
  env_additions:
    - VAR1=value1
    - VAR2=value2`;

      const manifest = parseManifestContent(content);

      expect(manifest.skill).toBe('structured-skill');
      expect(manifest.structured?.env_additions).toEqual(['VAR1=value1', 'VAR2=value2']);
    });
  });

  describe('readManifest', () => {
    it('reads manifest from VFS', async () => {
      const skillDir = '/workspace/skills/test-skill';
      await fs.mkdir(skillDir, { recursive: true });
      const manifestContent = `skill: vfs-skill
version: 2.0.0
description: Read from VFS
author: VFS Author`;

      await fs.writeFile(`${skillDir}/manifest.yaml`, manifestContent);

      const manifest = await readManifest(fs, skillDir);

      expect(manifest.skill).toBe('vfs-skill');
      expect(manifest.version).toBe('2.0.0');
      expect(manifest.description).toBe('Read from VFS');
      expect(manifest.author).toBe('VFS Author');
    });

    it('throws when manifest file does not exist', async () => {
      const skillDir = '/workspace/skills/nonexistent';

      await expect(readManifest(fs, skillDir)).rejects.toThrow();
    });

    it('throws on invalid manifest in VFS', async () => {
      const skillDir = '/workspace/skills/invalid-skill';
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        `${skillDir}/manifest.yaml`,
        `version: 1.0.0\ndescription: Missing skill field`
      );

      await expect(readManifest(fs, skillDir)).rejects.toThrow(
        "Invalid manifest: missing 'skill' field"
      );
    });
  });

  describe('checkDependencies', () => {
    it('returns ok:true when all dependencies are satisfied', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
        depends: ['dep1', 'dep2', 'dep3'],
      };
      const appliedSkills = ['dep1', 'dep2', 'dep3', 'other'];

      const result = checkDependencies(manifest, appliedSkills);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('returns ok:false with missing list when deps are not satisfied', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
        depends: ['dep1', 'dep2', 'dep3'],
      };
      const appliedSkills = ['dep1'];

      const result = checkDependencies(manifest, appliedSkills);

      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(['dep2', 'dep3']);
    });

    it('returns ok:true when no dependencies are declared', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
        depends: [],
      };
      const appliedSkills = ['other1', 'other2'];

      const result = checkDependencies(manifest, appliedSkills);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('returns ok:true for undefined dependencies', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
      };
      const appliedSkills = ['any', 'thing'];

      const result = checkDependencies(manifest, appliedSkills);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });
  });

  describe('checkConflicts', () => {
    it('returns ok:true when no conflicts exist', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
        conflicts: ['conflict1', 'conflict2'],
      };
      const appliedSkills = ['other1', 'other2'];

      const result = checkConflicts(manifest, appliedSkills);

      expect(result.ok).toBe(true);
      expect(result.conflicting).toEqual([]);
    });

    it('returns ok:false with conflicting list when conflicts are installed', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
        conflicts: ['conflict1', 'conflict2', 'conflict3'],
      };
      const appliedSkills = ['conflict1', 'other', 'conflict3'];

      const result = checkConflicts(manifest, appliedSkills);

      expect(result.ok).toBe(false);
      expect(result.conflicting).toEqual(['conflict1', 'conflict3']);
    });

    it('returns ok:true when no conflicts are declared', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
        conflicts: [],
      };
      const appliedSkills = ['skill1', 'skill2'];

      const result = checkConflicts(manifest, appliedSkills);

      expect(result.ok).toBe(true);
      expect(result.conflicting).toEqual([]);
    });

    it('returns ok:true for undefined conflicts', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
      };
      const appliedSkills = ['skill1', 'skill2'];

      const result = checkConflicts(manifest, appliedSkills);

      expect(result.ok).toBe(true);
      expect(result.conflicting).toEqual([]);
    });

    it('detects single conflict', () => {
      const manifest = {
        skill: 'test',
        version: '1.0.0',
        description: '',
        conflicts: ['incompatible-skill'],
      };
      const appliedSkills = ['incompatible-skill'];

      const result = checkConflicts(manifest, appliedSkills);

      expect(result.ok).toBe(false);
      expect(result.conflicting).toEqual(['incompatible-skill']);
    });
  });
});
