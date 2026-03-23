import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import { createSayCommand } from './say-command.js';

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

describe('say command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createSayCommand();
    expect(cmd.name).toBe('say');
  });

  it('shows help with --help', async () => {
    const cmd = createSayCommand();
    const result = await cmd.execute(['--help'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: say');
    expect(result.stderr).toBe('');
  });

  it('shows help with -h', async () => {
    const cmd = createSayCommand();
    const result = await cmd.execute(['-h'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: say');
  });

  it('returns error when Web Speech API unavailable', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', undefined);

    const cmd = createSayCommand();
    const result = await cmd.execute(['hello'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Web Speech API unavailable');
  });

  it('returns error for -v without value', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const cmd = createSayCommand();
    const result = await cmd.execute(['-v', '-r', '1', 'hello'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('say: -v requires a voice name\n');
  });

  it('returns error for -r without value', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const cmd = createSayCommand();
    const result = await cmd.execute(['-r', '-v', 'test', 'hello'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('say: -r requires a rate value\n');
  });

  it('returns error for invalid rate', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const cmd = createSayCommand();
    const result = await cmd.execute(['-r', '100', 'hello'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rate must be between');
  });

  it('returns error for unknown option', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const cmd = createSayCommand();
    const result = await cmd.execute(['--unknown', 'hello'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('say: unknown option: --unknown\n');
  });

  it('shows help when no text provided', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const cmd = createSayCommand();
    const result = await cmd.execute([], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: say');
  });
});
