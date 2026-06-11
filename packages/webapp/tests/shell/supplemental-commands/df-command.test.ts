import type { IFileSystem } from 'just-bash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../../src/fs/index.js';
import {
  createDfCommand,
  createDiskutilCommand,
} from '../../../src/shell/supplemental-commands/df-command.js';

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

function stubStorage(
  estimate: { usage?: number; quota?: number } | null,
  persisted: boolean | null
): void {
  const storage: { estimate?: () => Promise<unknown>; persisted?: () => Promise<boolean> } = {};
  if (estimate !== null) {
    storage.estimate = async () => estimate;
  }
  if (persisted !== null) {
    storage.persisted = async () => persisted;
  }
  vi.stubGlobal('navigator', { storage });
}

describe('df command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    expect(createDfCommand().name).toBe('df');
  });

  it('shows help with --help', async () => {
    stubStorage({ usage: 0, quota: 0 }, false);
    const cmd = createDfCommand({
      fs: fakeFs('opfs'),
      legacyIdbExists: async () => false,
    });
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('df');
    expect(result.stdout).toContain('Usage:');
  });

  it('rejects unknown arguments', async () => {
    stubStorage({ usage: 0, quota: 0 }, false);
    const cmd = createDfCommand({
      fs: fakeFs('opfs'),
      legacyIdbExists: async () => false,
    });
    const result = await cmd.execute(['--bogus'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported argument');
  });

  it('reports opfs backend, usage/quota in bytes, persisted, and legacy IDB state', async () => {
    stubStorage({ usage: 1_500_000_000, quota: 10_000_000_000 }, true);
    const cmd = createDfCommand({
      fs: fakeFs('opfs'),
      legacyIdbExists: async () => true,
    });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Backend:     opfs');
    expect(result.stdout).toContain('Usage:       1500000000');
    expect(result.stdout).toContain('Quota:       10000000000');
    expect(result.stdout).toContain('Used:        15%');
    expect(result.stdout).toContain('Persisted:   true');
    expect(result.stdout).toContain('Legacy IDB:  present (slicc-fs)');
    // The migration is gone — the report carries no sentinel row anymore.
    expect(result.stdout).not.toContain('Migrated:');
  });

  it('formats sizes human-readably with -h', async () => {
    stubStorage({ usage: 1_500_000_000, quota: 10_000_000_000 }, true);
    const cmd = createDfCommand({
      fs: fakeFs('opfs'),
      legacyIdbExists: async () => false,
    });
    const result = await cmd.execute(['-h'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage:\s+1\.\d{2} GB/);
    expect(result.stdout).toMatch(/Quota:\s+9\.\d{2} GB/);
    expect(result.stdout).toContain('Legacy IDB:  absent');
  });

  it('reports the memory backend without any migration rows', async () => {
    stubStorage({ usage: 1024, quota: 4096 }, false);
    const cmd = createDfCommand({
      fs: fakeFs('memory'),
      legacyIdbExists: async () => false,
    });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Backend:     memory');
    expect(result.stdout).not.toContain('Migrated:');
  });

  it('reports "unavailable" when navigator.storage is missing', async () => {
    vi.stubGlobal('navigator', {});
    const cmd = createDfCommand({
      fs: fakeFs('opfs'),
      legacyIdbExists: async () => false,
    });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:       unavailable');
    expect(result.stdout).toContain('Quota:       unavailable');
    expect(result.stdout).toContain('Used:        unavailable');
    expect(result.stdout).toContain('Persisted:   unavailable');
  });

  it('handles missing VFS by reporting backend=unknown', async () => {
    stubStorage({ usage: 0, quota: 0 }, false);
    const cmd = createDfCommand({
      legacyIdbExists: async () => false,
    });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Backend:     unknown');
  });
});

describe('diskutil command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    expect(createDiskutilCommand().name).toBe('diskutil');
  });

  it("emits the same report as 'df -h' for 'diskutil info'", async () => {
    stubStorage({ usage: 1_500_000_000, quota: 10_000_000_000 }, true);
    const sharedOpts = {
      fs: fakeFs('opfs'),
      legacyIdbExists: async () => false,
    };
    const dfOut = await createDfCommand(sharedOpts).execute(['-h'], createMockCtx());
    const diskutilOut = await createDiskutilCommand(sharedOpts).execute(['info'], createMockCtx());
    expect(diskutilOut.exitCode).toBe(0);
    expect(diskutilOut.stdout).toBe(dfOut.stdout);
  });

  it('rejects unknown subcommands', async () => {
    const cmd = createDiskutilCommand({ fs: fakeFs('opfs') });
    const result = await cmd.execute(['list'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported subcommand');
  });

  it('errors with no subcommand', async () => {
    const cmd = createDiskutilCommand({ fs: fakeFs('opfs') });
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing subcommand');
  });

  it('shows help with --help', async () => {
    const cmd = createDiskutilCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('diskutil');
    expect(result.stdout).toContain('Usage:');
  });
});
