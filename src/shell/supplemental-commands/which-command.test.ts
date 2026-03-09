import { describe, it, expect, vi } from 'vitest';
import { createWhichCommand } from './which-command.js';
import type { IFileSystem } from 'just-bash';

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

describe('which command', () => {
  const cmd = createWhichCommand();

  it('has correct name', () => {
    expect(cmd.name).toBe('which');
  });

  it('shows help with --help', async () => {
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('locate a command');
  });

  it('returns error for no arguments', async () => {
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing argument');
  });

  it('resolves built-in command to /usr/bin/<name>', async () => {
    const result = await cmd.execute(['node'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/node\n');
  });

  it('resolves multiple built-in commands', async () => {
    const result = await cmd.execute(['ls', 'cat'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/ls\n/usr/bin/cat\n');
  });

  it('returns exit code 1 for unknown command', async () => {
    const result = await cmd.execute(['nonexistent'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('returns exit code 1 if any command is not found (mixed)', async () => {
    const result = await cmd.execute(['node', 'nonexistent'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('/usr/bin/node\n');
  });

  it('finds .jsh file on VFS', async () => {
    const mockFs: Partial<IFileSystem> = {
      resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
      readdir: vi.fn()
        .mockImplementation(async (path: string) => {
          if (path === '/') return ['workspace'];
          if (path === '/workspace') return ['skills'];
          if (path === '/workspace/skills') return ['test-skill'];
          if (path === '/workspace/skills/test-skill') return ['hello.jsh', 'SKILL.md'];
          return [];
        }),
      stat: vi.fn()
        .mockImplementation(async (path: string) => {
          const dirs = ['/', '/workspace', '/workspace/skills', '/workspace/skills/test-skill'];
          if (dirs.includes(path)) return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date() };
          return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size: 100, mtime: new Date() };
        }),
    };

    const result = await cmd.execute(['hello'], createMockCtx({
      registeredCommands: ['ls', 'cat'],
      fs: mockFs,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/workspace/skills/test-skill/hello.jsh\n');
  });
});
