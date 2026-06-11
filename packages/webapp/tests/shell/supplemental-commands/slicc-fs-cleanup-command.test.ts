import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupLegacyIdb,
  createSliccFsCleanupCommand,
  type LegacyIdbCleanupResult,
} from '../../../src/shell/supplemental-commands/slicc-fs-cleanup-command.js';

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

describe('slicc-fs-cleanup command', () => {
  it('shows help with --help', async () => {
    const cmd = createSliccFsCleanupCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('slicc-fs-cleanup');
    expect(result.stdout).toContain('Usage:');
  });

  it('runs the cleanup ONLY when explicitly invoked', async () => {
    const runCleanup = vi.fn(
      async () =>
        ({ kind: 'deleted', message: 'legacy slicc-fs IDB deleted' }) as LegacyIdbCleanupResult
    );
    const cmd = createSliccFsCleanupCommand({ runCleanup });
    // Constructing the command alone must not trigger any deletion.
    expect(runCleanup).not.toHaveBeenCalled();
    const result = await cmd.execute([], createMockCtx());
    expect(runCleanup).toHaveBeenCalledTimes(1);
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
    const cmd = createSliccFsCleanupCommand({ runCleanup });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('nothing to clean');
  });

  it('rejects unknown arguments without running the destructive driver', async () => {
    const runCleanup = vi.fn(
      async () => ({ kind: 'deleted', message: '' }) as LegacyIdbCleanupResult
    );
    const cmd = createSliccFsCleanupCommand({ runCleanup });
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
      const cmd = createSliccFsCleanupCommand({ runCleanup });
      const result = await cmd.execute([], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(kind);
    }
  });
});

describe('cleanupLegacyIdb (deletion-only driver)', () => {
  it('reports absent without attempting a delete when the IDB is gone', async () => {
    const deleteDatabase = vi.fn();
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'something-else' }],
      deleteDatabase,
    });
    try {
      const result = await cleanupLegacyIdb();
      expect(result.kind).toBe('absent');
      expect(deleteDatabase).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('deletes the legacy slicc-fs IDB when present — and NEVER opens/reads it', async () => {
    const open = vi.fn();
    const deleteDatabase = vi.fn(() => {
      const req: Partial<IDBOpenDBRequest> = {};
      queueMicrotask(() => (req as { onsuccess?: () => void }).onsuccess?.());
      return req as IDBOpenDBRequest;
    });
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'slicc-fs' }],
      deleteDatabase,
      open,
    });
    try {
      const result = await cleanupLegacyIdb();
      expect(result.kind).toBe('deleted');
      expect(deleteDatabase).toHaveBeenCalledWith('slicc-fs');
      // The whole point of removing the migration: no read path remains.
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces blocked deletions as a retryable outcome', async () => {
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'slicc-fs' }],
      deleteDatabase: () => {
        const req: Partial<IDBOpenDBRequest> = {};
        queueMicrotask(() => (req as { onblocked?: () => void }).onblocked?.());
        return req as IDBOpenDBRequest;
      },
    });
    try {
      const result = await cleanupLegacyIdb();
      expect(result.kind).toBe('blocked');
      expect(result.message).toContain('close other tabs');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
