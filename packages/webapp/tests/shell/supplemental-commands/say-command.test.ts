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

  it('help advertises multilingual on-device support (not English-only)', async () => {
    const cmd = createSayCommand();
    const result = await cmd.execute(['--help'], createMockCtx());

    expect(result.stdout).toContain('Spanish');
    expect(result.stdout).toContain('[kokoro]');
    expect(result.stdout).not.toMatch(/English text/i);
  });

  it('--list shows every kokoro voice with language + engine marker (local realm)', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ name: 'Alex', lang: 'en-US', default: true }],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.doMock('../../../src/speech/speak.js', () => ({
      kokoroVoicesIfReady: () => [
        { id: 'ef_dora', name: 'Dora', lang: 'es-ES', onDevice: true },
        { id: 'jf_alpha', name: 'Alpha', lang: 'ja-JP', onDevice: false },
      ],
    }));
    vi.resetModules();
    const { createSayCommand: makeCmd } = await import(
      '../../../src/shell/supplemental-commands/say-command.js'
    );

    const result = await makeCmd().execute(['--list'], createMockCtx());
    expect(result.exitCode).toBe(0);
    // On-device Spanish kokoro voice → [kokoro]; ja kokoro voice has no JS G2P
    // → [web speech]; Web Speech voice → [web speech] + [default].
    expect(result.stdout).toContain('ef_dora (es-ES) [kokoro]');
    expect(result.stdout).toContain('jf_alpha (ja-JP) [web speech]');
    expect(result.stdout).toContain('Alex (en-US) [web speech] [default]');
    vi.doUnmock('../../../src/speech/speak.js');
  });

  it('--list formats voices from the worker panel-RPC with engine markers', async () => {
    const call = vi.fn().mockResolvedValue({
      voices: [
        { name: 'ef_dora', lang: 'es-ES', default: false, onDevice: true },
        { name: 'Samantha', lang: 'en-US', default: true, onDevice: false },
      ],
    });
    vi.doMock('../../../src/kernel/panel-rpc.js', () => ({
      getPanelRpcClient: () => ({ call }),
    }));
    vi.resetModules();
    const { createSayCommand: makeCmd } = await import(
      '../../../src/shell/supplemental-commands/say-command.js'
    );

    const result = await makeCmd().execute(['--list'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(call).toHaveBeenCalledWith('list-voices', undefined);
    expect(result.stdout).toContain('ef_dora (es-ES) [kokoro]');
    expect(result.stdout).toContain('Samantha (en-US) [web speech] [default]');
    vi.doUnmock('../../../src/kernel/panel-rpc.js');
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

  it('speakViaRpc passes the elevated timeout (no window → worker path)', async () => {
    // No window/speechSynthesis stubs → bridge.local is false, so the command
    // bridges over panel-RPC. Synthesis can outlast the 15s default, so the
    // call must carry the afplay-style 5-minute ceiling.
    const call = vi.fn().mockResolvedValue({ done: true });
    vi.doMock('../../../src/kernel/panel-rpc.js', () => ({
      getPanelRpcClient: () => ({ call }),
    }));
    vi.resetModules();
    const { createSayCommand: makeCmd } = await import(
      '../../../src/shell/supplemental-commands/say-command.js'
    );

    const result = await makeCmd().execute(['-l', 'en-US', 'Hello there.'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(call).toHaveBeenCalledWith(
      'speak-text',
      { text: 'Hello there.', lang: 'en-US', voice: undefined, rate: 1 },
      { timeoutMs: 5 * 60_000 }
    );
    vi.doUnmock('../../../src/kernel/panel-rpc.js');
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
