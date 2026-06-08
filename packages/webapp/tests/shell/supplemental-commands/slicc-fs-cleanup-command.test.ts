import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../../src/fs/index.js';
import type { LegacyIdbCleanupResult } from '../../../src/fs/migration/migration-cleanup.js';
import { createSliccFsCleanupCommand } from '../../../src/shell/supplemental-commands/slicc-fs-cleanup-command.js';

function createMockCtx() {
  return {
    fs: {
      resolvePath: (b: string, p: string) => (p.startsWith('/') ? p : `${b}/${p}`),
    } as IFileSystem,
    cwd: '/',
    env: new Map<string, string>(),
    stdin: '',
  };
}

function fakeFs(backend: 'memory' | 'opfs'): VirtualFS {
  return { backend } as unknown as VirtualFS;
}

describe('slicc-fs-cleanup command', () => {
  it('shows help with --help', async () => {
    const cmd = createSliccFsCleanupCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('slicc-fs-cleanup');
    expect(result.stdout).toContain('Usage:');
  });

  it('is inert on the non-OPFS backend (flag-off path)', async () => {
    const runCleanup = vi.fn(
      async () => ({ kind: 'deleted', message: '' }) as LegacyIdbCleanupResult
    );
    const cmd = createSliccFsCleanupCommand({ fs: fakeFs('memory'), runCleanup });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('OPFS migration not active');
    // The destructive driver must NEVER fire on the flag-off backend.
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it('is inert when no VFS is supplied to the shell (no automatic deletion)', async () => {
    const runCleanup = vi.fn(
      async () => ({ kind: 'deleted', message: '' }) as LegacyIdbCleanupResult
    );
    const cmd = createSliccFsCleanupCommand({ runCleanup });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it('runs the cleanup ONLY when explicitly invoked on the OPFS backend', async () => {
    const runCleanup = vi.fn(
      async () =>
        ({ kind: 'deleted', message: 'legacy slicc-fs IDB deleted' }) as LegacyIdbCleanupResult
    );
    const fs = fakeFs('opfs');
    const cmd = createSliccFsCleanupCommand({ fs, runCleanup });
    // Constructing the command alone must not trigger any deletion.
    expect(runCleanup).not.toHaveBeenCalled();
    const result = await cmd.execute([], createMockCtx());
    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(runCleanup).toHaveBeenCalledWith(fs);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('deleted');
  });

  it('exits 0 with stdout when the legacy IDB is already absent', async () => {
    const runCleanup = vi.fn(
      async () =>
        ({
          kind: 'absent',
          message: 'legacy slicc-fs IDB not present — nothing to clean',
        }) as LegacyIdbCleanupResult
    );
    const cmd = createSliccFsCleanupCommand({ fs: fakeFs('opfs'), runCleanup });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('nothing to clean');
  });

  it('exits non-zero with stderr when the sentinel is missing (refusal)', async () => {
    const runCleanup = vi.fn(
      async () =>
        ({
          kind: 'sentinel-missing',
          message: 'migration sentinel not present',
        }) as LegacyIdbCleanupResult
    );
    const cmd = createSliccFsCleanupCommand({ fs: fakeFs('opfs'), runCleanup });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('sentinel');
  });

  it('rejects unknown arguments without running the destructive driver', async () => {
    const runCleanup = vi.fn(
      async () => ({ kind: 'deleted', message: '' }) as LegacyIdbCleanupResult
    );
    const cmd = createSliccFsCleanupCommand({ fs: fakeFs('opfs'), runCleanup });
    const result = await cmd.execute(['--dry-run'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported argument');
    expect(result.stderr).toContain('--dry-run');
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it('exits non-zero with stderr on blocked / error outcomes', async () => {
    for (const kind of ['blocked', 'error'] as const) {
      const runCleanup = vi.fn(
        async () => ({ kind, message: `outcome:${kind}` }) as LegacyIdbCleanupResult
      );
      const cmd = createSliccFsCleanupCommand({ fs: fakeFs('opfs'), runCleanup });
      const result = await cmd.execute([], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(kind);
    }
  });
});
