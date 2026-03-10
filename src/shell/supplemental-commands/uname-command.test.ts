import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import { createUnameCommand } from './uname-command.js';

function createMockCtx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };

  return {
    fs: fs as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

describe('uname command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createUnameCommand();
    expect(cmd.name).toBe('uname');
  });

  it('shows help with --help', async () => {
    const cmd = createUnameCommand();
    const result = await cmd.execute(['--help'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('usage: uname\n');
    expect(result.stderr).toBe('');
  });

  it('prints navigator.userAgent with trailing newline', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Test Browser/1.0' });

    const cmd = createUnameCommand();
    const result = await cmd.execute([], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Test Browser/1.0\n');
    expect(result.stderr).toBe('');
  });

  it('returns an error for unsupported arguments', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Test Browser/1.0' });

    const cmd = createUnameCommand();
    const result = await cmd.execute(['-a'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('uname: unsupported arguments\n');
  });

  it('returns an error when navigator.userAgent is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    const cmd = createUnameCommand();
    const result = await cmd.execute([], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('uname: navigator.userAgent is unavailable\n');
  });
});