import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GLOBAL_FS_DB_NAME } from '../../src/fs/global-db.js';
import {
  GLOBAL_GITCONFIG_PATH,
  readGlobalGitConfigValue,
  writeGlobalGitConfigValue,
  removeGitConfigKey,
} from '../../src/git/git-config.js';

let dbCounter = 0;

describe('git-config helpers', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `git-config-${dbCounter++}`, wipe: true });
  });

  describe('readGlobalGitConfigValue', () => {
    it('returns undefined when the config file does not exist', async () => {
      expect(await readGlobalGitConfigValue(fs, 'user.name')).toBeUndefined();
    });

    it('returns undefined when the key is absent', async () => {
      await fs.writeFile(GLOBAL_GITCONFIG_PATH, '[user]\n\tname = Octocat\n');
      expect(await readGlobalGitConfigValue(fs, 'user.email')).toBeUndefined();
    });

    it('reads a simple key', async () => {
      await fs.writeFile(GLOBAL_GITCONFIG_PATH, '[user]\n\tname = Octocat\n');
      expect(await readGlobalGitConfigValue(fs, 'user.name')).toBe('Octocat');
    });

    it('reads a subsection key', async () => {
      await fs.writeFile(GLOBAL_GITCONFIG_PATH, '[branch "main"]\n\tremote = origin\n');
      expect(await readGlobalGitConfigValue(fs, 'branch.main.remote')).toBe('origin');
    });
  });

  describe('writeGlobalGitConfigValue', () => {
    it('creates the file when missing', async () => {
      await writeGlobalGitConfigValue(fs, 'user.name', 'Octocat');
      const content = await fs.readTextFile(GLOBAL_GITCONFIG_PATH);
      expect(content).toContain('[user]');
      expect(content).toContain('name = Octocat');
    });

    it('updates an existing key in place rather than appending a duplicate', async () => {
      await fs.writeFile(GLOBAL_GITCONFIG_PATH, '[user]\n\tname = Old Name\n');
      await writeGlobalGitConfigValue(fs, 'user.name', 'New Name');
      const content = await fs.readTextFile(GLOBAL_GITCONFIG_PATH);
      expect(content).toContain('name = New Name');
      expect(content).not.toContain('Old Name');
      expect(content.match(/name =/g)?.length ?? 0).toBe(1);
    });

    it('adds a new key to an existing section', async () => {
      await fs.writeFile(GLOBAL_GITCONFIG_PATH, '[user]\n\tname = Octocat\n');
      await writeGlobalGitConfigValue(fs, 'user.email', 'octo@example.com');
      expect(await readGlobalGitConfigValue(fs, 'user.name')).toBe('Octocat');
      expect(await readGlobalGitConfigValue(fs, 'user.email')).toBe('octo@example.com');
    });

    it('round-trips a subsection key', async () => {
      await writeGlobalGitConfigValue(fs, 'branch.main.remote', 'origin');
      expect(await readGlobalGitConfigValue(fs, 'branch.main.remote')).toBe('origin');
    });
  });

  describe('removeGitConfigKey', () => {
    it('removes only the matching key, preserving section headers and other keys', () => {
      const content = '[user]\n\tname = Octocat\n\temail = octo@example.com\n';
      const result = removeGitConfigKey(content, 'user.email');
      expect(result).toContain('name = Octocat');
      expect(result).not.toContain('octo@example.com');
      expect(result).toContain('[user]');
    });

    it('returns the input unchanged when the key is not present', () => {
      const content = '[user]\n\tname = Octocat\n';
      expect(removeGitConfigKey(content, 'user.email')).toBe(content);
    });
  });
});

describe('GitHub identity helpers', () => {
  describe('buildNoreplyEmail', () => {
    it('formats <id>+<login>@users.noreply.github.com', async () => {
      const { buildNoreplyEmail } = await import('../../providers/github.js');
      expect(buildNoreplyEmail(583231, 'octocat')).toBe('583231+octocat@users.noreply.github.com');
    });
  });

  describe('syncGitIdentityFromGitHub', () => {
    /**
     * The provider hardcodes GLOBAL_FS_DB_NAME so we cannot pass a unique db
     * per test. Instead share one VirtualFS instance for the whole describe
     * and reset state by deleting the single file the tests touch. We avoid
     * `VirtualFS.create({ wipe: true })` per-test because that races with
     * still-open IndexedDB handles from prior tests — Node 24+'s Web Locks
     * API rejects the second wipe with an AbortError and trips Vitest's
     * unhandled-rejection guard. (Locally on Node 22 it slips through.)
     */
    let sharedFs: VirtualFS;

    beforeEach(async () => {
      sharedFs ??= await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
      try {
        await sharedFs.rm(GLOBAL_GITCONFIG_PATH);
      } catch {
        /* not present */
      }
    });

    it('writes user.name and a noreply email when neither is set', async () => {
      const { syncGitIdentityFromGitHub } = await import('../../providers/github.js');
      await syncGitIdentityFromGitHub({ id: 42, login: 'octocat', name: 'The Octocat' });

      expect(await readGlobalGitConfigValue(sharedFs, 'user.name')).toBe('The Octocat');
      expect(await readGlobalGitConfigValue(sharedFs, 'user.email')).toBe(
        '42+octocat@users.noreply.github.com'
      );
    });

    it('falls back to the login when the GitHub display name is empty', async () => {
      const { syncGitIdentityFromGitHub } = await import('../../providers/github.js');
      await syncGitIdentityFromGitHub({ id: 7, login: 'mona', name: undefined });

      expect(await readGlobalGitConfigValue(sharedFs, 'user.name')).toBe('mona');
    });

    it('preserves existing user.name and user.email values (idempotent)', async () => {
      await writeGlobalGitConfigValue(sharedFs, 'user.name', 'Custom Name');
      await writeGlobalGitConfigValue(sharedFs, 'user.email', 'custom@example.com');

      const { syncGitIdentityFromGitHub } = await import('../../providers/github.js');
      await syncGitIdentityFromGitHub({ id: 42, login: 'octocat', name: 'The Octocat' });

      expect(await readGlobalGitConfigValue(sharedFs, 'user.name')).toBe('Custom Name');
      expect(await readGlobalGitConfigValue(sharedFs, 'user.email')).toBe('custom@example.com');
    });

    it('skips silently when the profile is missing id or login', async () => {
      const { syncGitIdentityFromGitHub } = await import('../../providers/github.js');
      await syncGitIdentityFromGitHub({ name: 'Anonymous' });

      expect(await readGlobalGitConfigValue(sharedFs, 'user.name')).toBeUndefined();
      expect(await readGlobalGitConfigValue(sharedFs, 'user.email')).toBeUndefined();
    });
  });
});
