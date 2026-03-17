import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/index.js';
import {
  initSkillsSystem,
  readState,
  writeState,
  getAppliedSkills,
  recordSkillApplication,
  removeSkillFromState,
  computeFileHash,
} from './state.js';
import type { SkillsState, AppliedSkill } from './types.js';
import { SLICC_DIR, STATE_FILE, SKILLS_SYSTEM_VERSION } from './constants.js';

describe('Skills State Management', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;
  const STATE_PATH = `/${SLICC_DIR}/${STATE_FILE}`;

  beforeEach(async () => {
    // Create fresh VFS with unique DB name for test isolation
    vfs = await VirtualFS.create({
      dbName: `test-state-${dbCounter++}`,
      wipe: true,
    });
  });

  describe('initSkillsSystem', () => {
    it('creates directory and state file', async () => {
      await initSkillsSystem(vfs);

      // Verify .slicc directory exists
      const dirExists = await vfs.exists(`/${SLICC_DIR}`);
      expect(dirExists).toBe(true);

      // Verify state file exists with correct content
      const state = await readState(vfs);
      expect(state.version).toBe(SKILLS_SYSTEM_VERSION);
      expect(state.applied_skills).toEqual([]);
    });

    it('is idempotent (calling twice does not error)', async () => {
      // First call
      await initSkillsSystem(vfs);

      // Second call should not throw
      await initSkillsSystem(vfs);

      // State should still be valid
      const state = await readState(vfs);
      expect(state.version).toBe(SKILLS_SYSTEM_VERSION);
      expect(state.applied_skills).toEqual([]);
    });

    it('does not overwrite existing state file', async () => {
      // Initialize once
      await initSkillsSystem(vfs);

      // Write some data to the state
      const stateWithSkill: SkillsState = {
        version: SKILLS_SYSTEM_VERSION,
        applied_skills: [
          {
            name: 'test-skill',
            version: '1.0.0',
            applied_at: '2026-01-01T00:00:00Z',
            file_hashes: {},
          },
        ],
      };
      await writeState(vfs, stateWithSkill);

      // Initialize again
      await initSkillsSystem(vfs);

      // Data should still be there
      const state = await readState(vfs);
      expect(state.applied_skills).toHaveLength(1);
      expect(state.applied_skills[0].name).toBe('test-skill');
    });
  });

  describe('readState', () => {
    it('returns empty state when no file exists', async () => {
      const state = await readState(vfs);

      expect(state.version).toBe(SKILLS_SYSTEM_VERSION);
      expect(state.applied_skills).toEqual([]);
    });

    it('reads persisted state correctly', async () => {
      // Initialize and create a state with data
      await initSkillsSystem(vfs);
      const originalState: SkillsState = {
        version: SKILLS_SYSTEM_VERSION,
        applied_skills: [
          {
            name: 'skill-alpha',
            version: '2.1.0',
            applied_at: '2026-02-15T10:30:00Z',
            file_hashes: { 'file1.ts': 'abc123', 'file2.md': 'def456' },
            added_files: ['file1.ts', 'file2.md'],
          },
          {
            name: 'skill-beta',
            version: '1.5.2',
            applied_at: '2026-02-16T14:20:00Z',
            file_hashes: { 'config.json': '789ghi' },
          },
        ],
      };
      await writeState(vfs, originalState);

      // Read it back
      const readBack = await readState(vfs);

      expect(readBack.version).toBe(SKILLS_SYSTEM_VERSION);
      expect(readBack.applied_skills).toHaveLength(2);
      expect(readBack.applied_skills[0].name).toBe('skill-alpha');
      expect(readBack.applied_skills[0].version).toBe('2.1.0');
      expect(readBack.applied_skills[0].file_hashes).toEqual({
        'file1.ts': 'abc123',
        'file2.md': 'def456',
      });
      expect(readBack.applied_skills[1].name).toBe('skill-beta');
    });

    it('throws on corrupted JSON', async () => {
      // Initialize and write corrupted JSON
      await initSkillsSystem(vfs);
      await vfs.writeFile(STATE_PATH, '{not valid json}');

      // Reading should throw
      await expect(readState(vfs)).rejects.toThrow();
    });
  });

  describe('writeState + readState roundtrip', () => {
    it('preserves state through write and read', async () => {
      const skill: AppliedSkill = {
        name: 'roundtrip-skill',
        version: '3.2.1',
        applied_at: '2026-03-10T12:00:00Z',
        file_hashes: {
          'src/index.ts': 'hash1',
          'src/lib.ts': 'hash2',
          'package.json': 'hash3',
        },
        added_files: ['src/index.ts', 'src/lib.ts', 'package.json'],
      };

      const originalState: SkillsState = {
        version: SKILLS_SYSTEM_VERSION,
        applied_skills: [skill],
      };

      await writeState(vfs, originalState);
      const readBack = await readState(vfs);

      expect(readBack).toEqual(originalState);
    });
  });

  describe('getAppliedSkills', () => {
    it('returns names from state', async () => {
      // Set up state with some skills
      await initSkillsSystem(vfs);
      const state: SkillsState = {
        version: SKILLS_SYSTEM_VERSION,
        applied_skills: [
          {
            name: 'auth-skill',
            version: '1.0.0',
            applied_at: '2026-01-01T00:00:00Z',
            file_hashes: {},
          },
          {
            name: 'database-skill',
            version: '2.0.0',
            applied_at: '2026-01-02T00:00:00Z',
            file_hashes: {},
          },
          {
            name: 'cache-skill',
            version: '1.5.0',
            applied_at: '2026-01-03T00:00:00Z',
            file_hashes: {},
          },
        ],
      };
      await writeState(vfs, state);

      const names = await getAppliedSkills(vfs);

      expect(names).toEqual(['auth-skill', 'database-skill', 'cache-skill']);
    });

    it('returns empty array when no skills applied', async () => {
      const names = await getAppliedSkills(vfs);

      expect(names).toEqual([]);
    });
  });

  describe('recordSkillApplication', () => {
    it('adds new skill', async () => {
      const newSkill: AppliedSkill = {
        name: 'new-skill',
        version: '1.0.0',
        applied_at: new Date().toISOString(),
        file_hashes: { 'main.ts': 'abc123' },
        added_files: ['main.ts'],
      };

      await recordSkillApplication(vfs, newSkill);

      const names = await getAppliedSkills(vfs);
      expect(names).toContain('new-skill');

      const state = await readState(vfs);
      expect(state.applied_skills).toHaveLength(1);
      expect(state.applied_skills[0]).toEqual(newSkill);
    });

    it('updates existing skill (replaces by name)', async () => {
      // Add initial skill
      const skill1: AppliedSkill = {
        name: 'updatable-skill',
        version: '1.0.0',
        applied_at: '2026-01-01T00:00:00Z',
        file_hashes: { 'file1.ts': 'hash1' },
      };
      await recordSkillApplication(vfs, skill1);

      // Update it with same name but different version
      const skill2: AppliedSkill = {
        name: 'updatable-skill',
        version: '2.0.0',
        applied_at: '2026-03-01T00:00:00Z',
        file_hashes: { 'file1.ts': 'newhash1', 'file2.ts': 'hash2' },
        added_files: ['file1.ts', 'file2.ts'],
      };
      await recordSkillApplication(vfs, skill2);

      // Verify only one skill with that name exists
      const state = await readState(vfs);
      expect(state.applied_skills).toHaveLength(1);
      expect(state.applied_skills[0].version).toBe('2.0.0');
      expect(state.applied_skills[0].file_hashes).toEqual({
        'file1.ts': 'newhash1',
        'file2.ts': 'hash2',
      });
    });

    it('preserves other skills when updating', async () => {
      // Add first skill
      const skill1: AppliedSkill = {
        name: 'skill-1',
        version: '1.0.0',
        applied_at: '2026-01-01T00:00:00Z',
        file_hashes: {},
      };
      await recordSkillApplication(vfs, skill1);

      // Add second skill
      const skill2: AppliedSkill = {
        name: 'skill-2',
        version: '1.0.0',
        applied_at: '2026-01-02T00:00:00Z',
        file_hashes: {},
      };
      await recordSkillApplication(vfs, skill2);

      // Update first skill
      const skill1Updated: AppliedSkill = {
        name: 'skill-1',
        version: '2.0.0',
        applied_at: '2026-02-01T00:00:00Z',
        file_hashes: { 'updated.ts': 'hash' },
      };
      await recordSkillApplication(vfs, skill1Updated);

      // Verify both skills exist
      const state = await readState(vfs);
      expect(state.applied_skills).toHaveLength(2);
      expect(state.applied_skills.find((s) => s.name === 'skill-1')?.version).toBe(
        '2.0.0',
      );
      expect(state.applied_skills.find((s) => s.name === 'skill-2')?.version).toBe(
        '1.0.0',
      );
    });
  });

  describe('removeSkillFromState', () => {
    it('removes skill by name', async () => {
      // Set up state with two skills
      const skill1: AppliedSkill = {
        name: 'skill-to-remove',
        version: '1.0.0',
        applied_at: '2026-01-01T00:00:00Z',
        file_hashes: {},
      };
      const skill2: AppliedSkill = {
        name: 'skill-to-keep',
        version: '1.0.0',
        applied_at: '2026-01-02T00:00:00Z',
        file_hashes: {},
      };
      const state: SkillsState = {
        version: SKILLS_SYSTEM_VERSION,
        applied_skills: [skill1, skill2],
      };
      await writeState(vfs, state);

      // Remove the first skill
      await removeSkillFromState(vfs, 'skill-to-remove');

      // Verify it's gone
      const names = await getAppliedSkills(vfs);
      expect(names).toEqual(['skill-to-keep']);
    });

    it('is a no-op for nonexistent skill', async () => {
      // Set up state with one skill
      const skill: AppliedSkill = {
        name: 'existing-skill',
        version: '1.0.0',
        applied_at: '2026-01-01T00:00:00Z',
        file_hashes: {},
      };
      const state: SkillsState = {
        version: SKILLS_SYSTEM_VERSION,
        applied_skills: [skill],
      };
      await writeState(vfs, state);

      // Try to remove a nonexistent skill
      await removeSkillFromState(vfs, 'nonexistent-skill');

      // Existing skill should still be there
      const names = await getAppliedSkills(vfs);
      expect(names).toEqual(['existing-skill']);
    });

    it('removes skill from state with multiple skills', async () => {
      // Set up state with three skills
      const skills: AppliedSkill[] = [
        {
          name: 'skill-a',
          version: '1.0.0',
          applied_at: '2026-01-01T00:00:00Z',
          file_hashes: {},
        },
        {
          name: 'skill-b',
          version: '1.0.0',
          applied_at: '2026-01-02T00:00:00Z',
          file_hashes: {},
        },
        {
          name: 'skill-c',
          version: '1.0.0',
          applied_at: '2026-01-03T00:00:00Z',
          file_hashes: {},
        },
      ];
      const state: SkillsState = {
        version: SKILLS_SYSTEM_VERSION,
        applied_skills: skills,
      };
      await writeState(vfs, state);

      // Remove the middle one
      await removeSkillFromState(vfs, 'skill-b');

      // Verify correct removal
      const names = await getAppliedSkills(vfs);
      expect(names).toEqual(['skill-a', 'skill-c']);
    });
  });

  describe('computeFileHash', () => {
    it('produces consistent SHA-256 hex string', async () => {
      const content = 'The quick brown fox jumps over the lazy dog';

      const hash1 = await computeFileHash(content);
      const hash2 = await computeFileHash(content);

      // Should be consistent
      expect(hash1).toBe(hash2);

      // Should be a valid hex string
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('different content produces different hash', async () => {
      const content1 = 'Hello, World!';
      const content2 = 'Goodbye, World!';

      const hash1 = await computeFileHash(content1);
      const hash2 = await computeFileHash(content2);

      expect(hash1).not.toBe(hash2);
    });

    it('produces valid SHA-256 hex output (64 character hex string)', async () => {
      const content = 'test content';

      const hash = await computeFileHash(content);

      // SHA-256 produces 32 bytes = 64 hex characters
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash.length).toBe(64);
    });

    it('handles empty string', async () => {
      const hash = await computeFileHash('');

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // Empty string SHA-256 hash is well-known
      expect(hash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('handles special characters and unicode', async () => {
      const content = 'Special chars: !@#$%^&*() émojis: 🚀🌟';

      const hash = await computeFileHash(content);

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
