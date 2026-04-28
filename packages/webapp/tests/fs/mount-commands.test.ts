import { describe, it, expect, vi, afterEach } from 'vitest';
import { MountCommands } from '../../src/fs/mount-commands.js';
import type { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  pushToolExecutionContext,
  popToolExecutionContext,
  toolUIRegistry,
  type ToolExecutionContext,
} from '../../src/tools/tool-ui.js';

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

  describe('scoop (non-interactive) context', () => {
    it('fails fast with exitCode 1 when invoked from a scoop', async () => {
      const cmd = new MountCommands({ fs: makeFs(), isScoop: () => true });
      const result = await cmd.execute(['/workspace/myapp'], '/workspace');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cannot mount from a scoop');
    });

    it('does not invoke the directory picker or fs.mount in scoop context', async () => {
      const mount = vi.fn();
      const showDirectoryPicker = vi.fn();
      vi.stubGlobal('window', { showDirectoryPicker });
      try {
        const cmd = new MountCommands({ fs: makeFs({ mount }), isScoop: () => true });
        const result = await cmd.execute(['/workspace/myapp'], '/workspace');
        expect(result.exitCode).toBe(1);
        expect(showDirectoryPicker).not.toHaveBeenCalled();
        expect(mount).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('still allows list/unmount/refresh subcommands inside a scoop', async () => {
      const cmd = new MountCommands({
        fs: makeFs({ listMounts: vi.fn(() => []) }),
        isScoop: () => true,
      });
      const result = await cmd.execute(['list'], '/workspace');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('cone (interactive) timeout', () => {
    let pushedCtx: ToolExecutionContext | null = null;

    afterEach(() => {
      if (pushedCtx) {
        popToolExecutionContext(pushedCtx);
        pushedCtx = null;
      }
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('times out after 5 minutes, cancels the pending UI, and exits 1', async () => {
      vi.useFakeTimers();
      // mount only enters the timeout branch when window.showDirectoryPicker
      // exists; never resolved by the test, so the user-action path stays
      // pending and the timeout fires.
      vi.stubGlobal('window', { showDirectoryPicker: vi.fn() });

      const onUpdate = vi.fn();
      pushedCtx = pushToolExecutionContext({
        onUpdate,
        toolName: 'bash',
        toolCallId: 'tc-mount-timeout',
      });

      const cmd = new MountCommands({ fs: makeFs() });
      const pendingBefore = toolUIRegistry.getPendingIds().length;

      const promise = cmd.execute(['/workspace/myapp'], '/workspace');

      // Let the synchronous showToolUI register before advancing timers.
      await Promise.resolve();
      expect(toolUIRegistry.getPendingIds().length).toBe(pendingBefore + 1);

      // Trigger the 5-minute timeout deterministically.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      const result = await promise;

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('timed out');

      // Registry was cleaned up so a late click cannot re-trigger the
      // picker callback after the command exited.
      expect(toolUIRegistry.getPendingIds().length).toBe(pendingBefore);

      // tool_ui_done was emitted via onUpdate so the panel can clear the
      // approval prompt.
      const blocks = onUpdate.mock.calls.flatMap(
        (call) => (call[0]?.content ?? []) as Array<{ type?: string }>
      );
      expect(blocks.some((b) => b.type === 'tool_ui_done')).toBe(true);
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
