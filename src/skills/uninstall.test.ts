import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../fs/index.js';
import { uninstallSkill } from './uninstall.js';
import { initSkillsSystem, recordSkillApplication, readState } from './state.js';

const SKILLS_DIR = '/workspace/skills';

describe('uninstallSkill', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    fs = await VirtualFS.create();
    await initSkillsSystem(fs);
  });

  it('removes added files and updates state', async () => {
    // Set up skill with manifest and add files
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/removable-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/removable-skill/manifest.yaml`,
      `skill: removable-skill
version: 1.0.0
description: A skill to remove
adds:
  - added/file1.txt
  - added/file2.txt`
    );

    // Create the added files
    await fs.mkdir('/added', { recursive: true });
    await fs.writeFile('/added/file1.txt', 'content1');
    await fs.writeFile('/added/file2.txt', 'content2');

    // Record as installed
    await recordSkillApplication(fs, {
      name: 'removable-skill',
      version: '1.0.0',
      applied_at: new Date().toISOString(),
      file_hashes: {},
      added_files: ['added/file1.txt', 'added/file2.txt'],
    });

    // Verify files exist
    let exists1 = await fs.exists('/added/file1.txt');
    let exists2 = await fs.exists('/added/file2.txt');
    expect(exists1).toBe(true);
    expect(exists2).toBe(true);

    // Uninstall
    const result = await uninstallSkill(fs, 'removable-skill');
    expect(result.success).toBe(true);
    expect(result.skill).toBe('removable-skill');

    // Verify files removed
    exists1 = await fs.exists('/added/file1.txt');
    exists2 = await fs.exists('/added/file2.txt');
    expect(exists1).toBe(false);
    expect(exists2).toBe(false);

    // Verify state updated
    const state = await readState(fs);
    const stillInstalled = state.applied_skills.find((s) => s.name === 'removable-skill');
    expect(stillInstalled).toBeUndefined();
  });

  it('returns error for non-installed skill', async () => {
    const result = await uninstallSkill(fs, 'never-installed');
    expect(result.success).toBe(false);
    expect(result.skill).toBe('never-installed');
    expect(result.error).toContain('not installed');
  });

  it('blocks if another skill depends on it', async () => {
    // Install base skill
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/base-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/base-skill/manifest.yaml`,
      `skill: base-skill
version: 1.0.0
description: Base skill`
    );
    await recordSkillApplication(fs, {
      name: 'base-skill',
      version: '1.0.0',
      applied_at: new Date().toISOString(),
      file_hashes: {},
    });

    // Install dependent skill
    await fs.mkdir(`${SKILLS_DIR}/dependent-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/dependent-skill/manifest.yaml`,
      `skill: dependent-skill
version: 1.0.0
description: Depends on base
depends:
  - base-skill`
    );
    await recordSkillApplication(fs, {
      name: 'dependent-skill',
      version: '1.0.0',
      applied_at: new Date().toISOString(),
      file_hashes: {},
    });

    // Try to uninstall base
    const result = await uninstallSkill(fs, 'base-skill');
    expect(result.success).toBe(false);
    expect(result.error).toContain('depends on');
    expect(result.error).toContain('dependent-skill');
  });

  it('succeeds even when added files already deleted', async () => {
    // Set up skill and record it as installed
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/cleanup-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/cleanup-skill/manifest.yaml`,
      `skill: cleanup-skill
version: 1.0.0
description: Cleanup skill`
    );
    await recordSkillApplication(fs, {
      name: 'cleanup-skill',
      version: '1.0.0',
      applied_at: new Date().toISOString(),
      file_hashes: {},
      added_files: ['missing/file.txt'],
    });

    // File doesn't actually exist, but uninstall should still succeed
    const result = await uninstallSkill(fs, 'cleanup-skill');
    expect(result.success).toBe(true);

    // Verify state was updated
    const state = await readState(fs);
    const stillInstalled = state.applied_skills.find((s) => s.name === 'cleanup-skill');
    expect(stillInstalled).toBeUndefined();
  });

  it('validates paths (skips absolute/traversal paths during removal)', async () => {
    // Set up skill with invalid paths in added_files
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(`${SKILLS_DIR}/malicious-skill`);
    await fs.writeFile(
      `${SKILLS_DIR}/malicious-skill/manifest.yaml`,
      `skill: malicious-skill
version: 1.0.0
description: Malicious skill`
    );

    // Create some normal files that should be deleted
    await fs.writeFile('/normal-file.txt', 'should be deleted');

    // Record with mix of valid and invalid paths
    await recordSkillApplication(fs, {
      name: 'malicious-skill',
      version: '1.0.0',
      applied_at: new Date().toISOString(),
      file_hashes: {},
      added_files: [
        'normal-file.txt', // valid relative path
        '/etc/passwd', // absolute path - should be skipped
        '../../../evil', // traversal path - should be skipped
      ],
    });

    // Uninstall should succeed (skipping invalid paths)
    const result = await uninstallSkill(fs, 'malicious-skill');
    expect(result.success).toBe(true);

    // Normal file should be removed
    const exists = await fs.exists('/normal-file.txt');
    expect(exists).toBe(false);

    // State should be updated
    const state = await readState(fs);
    const stillInstalled = state.applied_skills.find((s) => s.name === 'malicious-skill');
    expect(stillInstalled).toBeUndefined();
  });
});
