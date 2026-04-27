import { describe, it, expect, vi } from 'vitest';
import { MountCommands } from '../../src/fs/mount-commands.js';
import type { VirtualFS } from '../../src/fs/virtual-fs.js';

function makeMockMountIndex() {
  return {
    getState: vi.fn(() => undefined),
    isReady: vi.fn(() => false),
  };
}

function makeFs(overrides: Partial<VirtualFS> = {}): VirtualFS {
  return {
    listMounts: vi.fn(() => []),
    unmount: vi.fn(),
    mount: vi.fn(),
    getMountIndex: vi.fn(() => makeMockMountIndex()),
    ...overrides,
  } as unknown as VirtualFS;
}

describe('MountCommands', () => {
  describe('no arguments', () => {
    it('returns exitCode 1', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute([], '/workspace');
      expect(result.exitCode).toBe(1);
    });

    it('includes "mount point required" in stderr', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute([], '/workspace');
      expect(result.stderr).toContain('mount: mount point required');
    });

    it('includes usage hint in stderr', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute([], '/workspace');
      expect(result.stderr).toContain('Usage: mount <target-path>');
    });

    it('stderr ends with a newline', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute([], '/workspace');
      expect(result.stderr).toMatch(/\n$/);
    });
  });

  describe('list subcommand', () => {
    it('returns exitCode 0 with no mounts', async () => {
      const cmd = new MountCommands({ fs: makeFs({ listMounts: vi.fn(() => []) }) });
      const result = await cmd.execute(['list'], '/workspace');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('No active mounts\n');
    });

    it('lists active mounts', async () => {
      const mounts = ['/workspace/myapp', '/workspace/other'];
      const cmd = new MountCommands({ fs: makeFs({ listMounts: vi.fn(() => mounts) }) });
      const result = await cmd.execute(['list'], '/workspace');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('/workspace/myapp');
      expect(result.stdout).toContain('/workspace/other');
    });

    it('-l alias works', async () => {
      const cmd = new MountCommands({ fs: makeFs({ listMounts: vi.fn(() => []) }) });
      const result = await cmd.execute(['-l'], '/workspace');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('unmount subcommand', () => {
    it('returns error when path is missing', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute(['unmount'], '/workspace');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('path required');
    });

    it('calls fs.unmount with absolute path', async () => {
      const unmount = vi.fn();
      const cmd = new MountCommands({ fs: makeFs({ unmount }) });
      const result = await cmd.execute(['unmount', '/workspace/myapp'], '/workspace');
      expect(result.exitCode).toBe(0);
      expect(unmount).toHaveBeenCalledWith('/workspace/myapp');
    });

    it('resolves relative path against cwd', async () => {
      const unmount = vi.fn();
      const cmd = new MountCommands({ fs: makeFs({ unmount }) });
      await cmd.execute(['unmount', 'myapp'], '/workspace');
      expect(unmount).toHaveBeenCalledWith('/workspace/myapp');
    });
  });

  describe('--help', () => {
    it('returns exitCode 0', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute(['--help'], '/workspace');
      expect(result.exitCode).toBe(0);
    });

    it('shows required <target-path> in usage', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute(['--help'], '/workspace');
      expect(result.stdout).toContain('Usage: mount <target-path>');
    });
  });
});
