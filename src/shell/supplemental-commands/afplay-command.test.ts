import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import { createAfplayCommand, createChimeCommand } from './afplay-command.js';

function createMockCtx(readFileBuffer?: (path: string) => Promise<Uint8Array>) {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    readFileBuffer: readFileBuffer ?? (() => Promise.reject(new Error('File not found'))),
  };

  return {
    fs: fs as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

describe('afplay command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createAfplayCommand();
    expect(cmd.name).toBe('afplay');
  });

  it('shows help with --help', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['--help'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: afplay');
    expect(result.stderr).toBe('');
  });

  it('shows help with -h', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['-h'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: afplay');
  });

  it('shows help when no args provided', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute([], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: afplay');
  });

  it('returns error when Web Audio API unavailable', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', undefined);

    const cmd = createAfplayCommand();
    const result = await cmd.execute(['/test.mp3'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Web Audio API unavailable');
  });

  it('returns error for -v without value', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['-v', '-r', '1', '/test.mp3'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('afplay: -v requires a volume value\n');
  });

  it('returns error for -r without value', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['-r', '-v', '0.5', '/test.mp3'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('afplay: -r requires a rate value\n');
  });

  it('returns error for -v at end without value', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['/test.mp3', '-v'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('afplay: -v requires a volume value\n');
  });

  it('returns error for invalid volume', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['-v', '5', '/test.mp3'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('volume must be between');
  });

  it('returns error for invalid rate', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['-r', '10', '/test.mp3'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rate must be between');
  });

  it('returns error for unknown option', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['--unknown', '/test.mp3'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('afplay: unknown option: --unknown\n');
  });

  it('returns error for multiple files', async () => {
    const cmd = createAfplayCommand();
    const result = await cmd.execute(['/test1.mp3', '/test2.mp3'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('afplay: only one file can be specified\n');
  });
});

describe('chime command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createChimeCommand();
    expect(cmd.name).toBe('chime');
  });

  it('shows help with --help', async () => {
    const cmd = createChimeCommand();
    const result = await cmd.execute(['--help'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: chime');
    expect(result.stdout).toContain('/shared/sounds/chime.mp3');
    expect(result.stderr).toBe('');
  });

  it('returns error when Web Audio API unavailable', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', undefined);

    const cmd = createChimeCommand();
    const result = await cmd.execute([], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Web Audio API unavailable');
  });
});
