import type { IFileSystem } from 'just-bash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSayCommand } from '../../../src/shell/supplemental-commands/say-command.js';

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

  it('returns error for -l without value', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const cmd = createSayCommand();
    const result = await cmd.execute(['-l', '-v', 'test', 'hello'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('say: -l requires a language tag\n');
  });

  it('returns error when -l is not provided', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const cmd = createSayCommand();
    const result = await cmd.execute(['hello', 'world'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('say: -l language tag is required\n');
  });

  it('sets utterance.lang when -l is provided', async () => {
    const mockUtterance: Record<string, unknown> = {};
    vi.stubGlobal('window', {});
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        constructor(text: string) {
          Object.assign(mockUtterance, { text });
          return mockUtterance;
        }
      }
    );
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      speak: (u: any) => {
        // Trigger onend to resolve the promise
        setTimeout(() => u.onend?.(), 0);
      },
    });

    const cmd = createSayCommand();
    const result = await cmd.execute(['-l', 'de-DE', 'Hallo', 'Welt'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(mockUtterance.lang).toBe('de-DE');
    expect(mockUtterance.text).toBe('Hallo Welt');
  });

  it('documents --status and --warmup in help', async () => {
    const cmd = createSayCommand();
    const result = await cmd.execute(['--help'], createMockCtx());

    expect(result.stdout).toContain('--status');
    expect(result.stdout).toContain('--warmup');
  });

  it('--status reports the on-device voice state (local realm)', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.doMock('../../../src/speech/speak.js', () => ({
      kokoroStatus: () => ({ state: 'ready' }),
      kokoroWarmup: vi.fn(),
    }));
    vi.resetModules();
    const { createSayCommand: makeCmd } = await import(
      '../../../src/shell/supplemental-commands/say-command.js'
    );

    const result = await makeCmd().execute(['--status'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('voice engine: ready\n');
    vi.doUnmock('../../../src/speech/speak.js');
  });

  it('--warmup kicks the warmup and prints initial status (local realm)', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const kokoroWarmup = vi.fn(() => ({
      state: 'loading' as const,
      loaded: 1024 * 1024,
      total: 4 * 1024 * 1024,
      etaSeconds: 12,
    }));
    vi.doMock('../../../src/speech/speak.js', () => ({
      kokoroStatus: () => ({ state: 'idle' }),
      kokoroWarmup,
    }));
    vi.resetModules();
    const { createSayCommand: makeCmd } = await import(
      '../../../src/shell/supplemental-commands/say-command.js'
    );

    const result = await makeCmd().execute(['--warmup'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(kokoroWarmup).toHaveBeenCalledOnce();
    expect(result.stdout).toBe('voice engine: downloading 1.0/4.0 MB · ready in ~12s\n');
    vi.doUnmock('../../../src/speech/speak.js');
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
