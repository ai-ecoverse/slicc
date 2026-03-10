import { describe, it, expect } from 'vitest';
import { createWhichCommand } from './which-command.js';
import type { IFileSystem } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';

function createMockCtx(overrides: {
  registeredCommands?: string[];
  fs?: Partial<IFileSystem>;
} = {}) {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
    getRegisteredCommands: () => overrides.registeredCommands ?? ['ls', 'cat', 'node', 'git'],
  };
}

/** Create a minimal VirtualFS mock that yields the given file paths from walk(). */
function createMockVfs(files: string[]): VirtualFS {
  return {
    exists: async () => true,
    walk: async function* () {
      for (const f of files) yield f;
    },
  } as unknown as VirtualFS;
}

describe('which command', () => {
  it('has correct name', () => {
    const cmd = createWhichCommand();
    expect(cmd.name).toBe('which');
  });

  it('shows help with --help', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('locate a command');
  });

  it('returns error for no arguments', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing argument');
  });

  it('resolves built-in command to /usr/bin/<name>', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['node'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/node\n');
  });

  it('resolves multiple built-in commands', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['ls', 'cat'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/ls\n/usr/bin/cat\n');
  });

  it('returns exit code 1 for unknown command', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['nonexistent'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('returns exit code 1 if any command is not found (mixed)', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['node', 'nonexistent'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('/usr/bin/node\n');
  });

  it('finds .jsh file on VFS', async () => {
    const mockVfs = createMockVfs([
      '/workspace/skills/test-skill/SKILL.md',
      '/workspace/skills/test-skill/hello.jsh',
    ]);

    const cmd = createWhichCommand(mockVfs);
    const result = await cmd.execute(['hello'], createMockCtx({
      registeredCommands: ['ls', 'cat'],
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/workspace/skills/test-skill/hello.jsh\n');
  });
});
