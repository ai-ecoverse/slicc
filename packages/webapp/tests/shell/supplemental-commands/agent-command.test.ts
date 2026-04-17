import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import { createAgentCommand } from '../../../src/shell/supplemental-commands/agent-command.js';

interface SpawnArgs {
  cwd: string;
  allowedCommands: string[];
  prompt: string;
  modelId?: string;
}

interface SpawnResult {
  finalText?: string | null;
  exitCode: number;
}

interface MockFsOptions {
  /** Override the default `stat` implementation. */
  stat?: IFileSystem['stat'];
  /** Override the default `exists` implementation. */
  exists?: IFileSystem['exists'];
}

function createMockCtx(cwd = '/home', fsOptions: MockFsOptions = {}) {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    exists:
      fsOptions.exists ??
      (async () => {
        return true;
      }),
    stat:
      fsOptions.stat ??
      (async () => ({
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 0,
        mtime: new Date(0),
      })),
  };
  return {
    fs: fs as IFileSystem,
    cwd,
    env: new Map<string, string>(),
    stdin: '',
  };
}

function installBridge(spawn: (args: SpawnArgs) => Promise<SpawnResult> | SpawnResult) {
  (globalThis as Record<string, unknown>).__slicc_agent = { spawn };
}

function clearBridge() {
  delete (globalThis as Record<string, unknown>).__slicc_agent;
}

describe('agent command', () => {
  beforeEach(() => {
    clearBridge();
  });

  afterEach(() => {
    clearBridge();
    vi.restoreAllMocks();
  });

  describe('basic registration', () => {
    it('has the correct name', () => {
      expect(createAgentCommand().name).toBe('agent');
    });

    it('has an execute function', () => {
      expect(typeof createAgentCommand().execute).toBe('function');
    });
  });

  describe('help text', () => {
    it('prints usage on --help and exits 0', async () => {
      const result = await createAgentCommand().execute(['--help'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('agent <cwd> <allowed-commands> <prompt>');
    });

    it('prints usage on -h and exits 0', async () => {
      const result = await createAgentCommand().execute(['-h'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('agent <cwd> <allowed-commands> <prompt>');
    });

    it('help text documents all four tokens <cwd> <allowed-commands> <prompt> --model', async () => {
      const result = await createAgentCommand().execute(['--help'], createMockCtx());
      expect(result.stdout).toContain('<cwd>');
      expect(result.stdout).toContain('<allowed-commands>');
      expect(result.stdout).toContain('<prompt>');
      expect(result.stdout).toContain('--model');
    });

    it('help text includes at least one concrete example', async () => {
      const result = await createAgentCommand().execute(['--help'], createMockCtx());
      // Example lines should start with `agent` and include a quoted token.
      expect(result.stdout).toMatch(/agent\b[^\n]*"[^"]*"/);
    });

    it('help flag wins over positional args (help first)', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(
        ['-h', '.', '*', 'ignored prompt'],
        createMockCtx()
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('agent <cwd> <allowed-commands> <prompt>');
      expect(bridge).not.toHaveBeenCalled();
    });

    it('help flag in last position still wins', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(
        ['.', '*', 'prompt', '--help'],
        createMockCtx()
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('agent <cwd> <allowed-commands> <prompt>');
      expect(bridge).not.toHaveBeenCalled();
    });

    it('--help beats --model', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(['--model', 'foo', '-h'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('agent <cwd> <allowed-commands> <prompt>');
      expect(bridge).not.toHaveBeenCalled();
    });
  });

  describe('argument count errors', () => {
    it('errors with zero args', async () => {
      const result = await createAgentCommand().execute([], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe('');
      expect(result.stdout).toBe('');
    });

    it('errors with only one positional arg', async () => {
      const result = await createAgentCommand().execute(['.'], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/allowed-commands|missing/);
    });

    it('errors with only two positional args', async () => {
      const result = await createAgentCommand().execute(['.', '*'], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/prompt|missing/);
    });

    it('errors with too many positional args', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(['.', '*', 'p', 'extra'], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe('');
      expect(bridge).not.toHaveBeenCalled();
    });

    it('three positional args are accepted as the happy path', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'ok', exitCode: 0 });
      installBridge(spawn);
      const result = await createAgentCommand().execute(['.', '*', 'say hi'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0][0]).toMatchObject({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'say hi',
      });
    });
  });

  describe('unknown flags', () => {
    it('errors on unknown long flag and does not call bridge', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(['--foo', '.', '*', 'p'], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/--foo|unknown/);
      expect(bridge).not.toHaveBeenCalled();
    });

    it('errors on unknown short flag and does not call bridge', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(['-x', '.', '*', 'p'], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/-x|unknown/);
      expect(bridge).not.toHaveBeenCalled();
    });
  });

  describe('cwd resolution', () => {
    it('resolves relative cwd against ctx.cwd', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['sub', '*', 'p'], createMockCtx('/home'));
      expect(spawn.mock.calls[0][0].cwd).toBe('/home/sub');
    });

    it('resolves "." to ctx.cwd', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', '*', 'p'], createMockCtx('/home/wiki'));
      expect(spawn.mock.calls[0][0].cwd).toBe('/home/wiki');
    });

    it('resolves ".." one level up', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['..', '*', 'p'], createMockCtx('/home/wiki'));
      expect(spawn.mock.calls[0][0].cwd).toBe('/home');
    });

    it('passes absolute cwd unchanged', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['/abs/path', '*', 'p'], createMockCtx('/home'));
      expect(spawn.mock.calls[0][0].cwd).toBe('/abs/path');
    });

    it('errors on empty-string cwd', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(['', '*', 'p'], createMockCtx('/home'));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe('');
      expect(bridge).not.toHaveBeenCalled();
    });
  });

  describe('cwd existence validation', () => {
    it('errors on nonexistent cwd without calling bridge', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const ctx = createMockCtx('/home', {
        stat: async () => {
          throw new Error('ENOENT');
        },
        exists: async () => false,
      });
      const result = await createAgentCommand().execute(['/does/not/exist', '*', 'p'], ctx);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('/does/not/exist');
      expect(bridge).not.toHaveBeenCalled();
    });

    it('errors on nonexistent relative cwd (resolved against ctx.cwd)', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const ctx = createMockCtx('/home', {
        stat: async () => {
          throw new Error('ENOENT');
        },
        exists: async () => false,
      });
      const result = await createAgentCommand().execute(['missing-subdir', '*', 'p'], ctx);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      // The resolved path (e.g. /home/missing-subdir) OR the original token
      // is expected to appear in stderr so the user can identify the target.
      expect(result.stderr).toMatch(/missing-subdir/);
      expect(bridge).not.toHaveBeenCalled();
    });

    it('errors when cwd exists but is not a directory', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const ctx = createMockCtx('/home', {
        stat: async () => ({
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o644,
          size: 42,
          mtime: new Date(0),
        }),
        exists: async () => true,
      });
      const result = await createAgentCommand().execute(['/etc/hosts', '*', 'p'], ctx);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('/etc/hosts');
      expect(bridge).not.toHaveBeenCalled();
    });

    it('happy path still succeeds when cwd exists and is a directory', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'ok', exitCode: 0 });
      installBridge(spawn);
      // Default createMockCtx reports all paths as existing directories.
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx('/home'));
      expect(result.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0][0].cwd).toBe('/home');
    });
  });

  describe('allowed-commands parsing', () => {
    it('parses comma list without whitespace', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', 'ls,wc,find', 'p'], createMockCtx());
      expect(spawn.mock.calls[0][0].allowedCommands).toEqual(['ls', 'wc', 'find']);
    });

    it('trims whitespace per entry', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', 'ls, wc , find ', 'p'], createMockCtx());
      expect(spawn.mock.calls[0][0].allowedCommands).toEqual(['ls', 'wc', 'find']);
    });

    it('parses "*" as wildcard sentinel', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(spawn.mock.calls[0][0].allowedCommands).toEqual(['*']);
    });

    it('keeps "*" when mixed with named commands', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', 'ls,*,wc', 'p'], createMockCtx());
      expect(spawn.mock.calls[0][0].allowedCommands).toContain('*');
    });

    it('tolerates duplicate entries', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', 'ls,ls,wc', 'p'], createMockCtx());
      const allowed = spawn.mock.calls[0][0].allowedCommands;
      expect(allowed).toContain('ls');
      expect(allowed).toContain('wc');
    });

    it('parses empty-string allow-list to empty array', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', '', 'p'], createMockCtx());
      expect(spawn.mock.calls[0][0].allowedCommands).toEqual([]);
    });
  });

  describe('prompt passthrough', () => {
    it('accepts an empty-string prompt', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: '', exitCode: 0 });
      installBridge(spawn);
      const result = await createAgentCommand().execute(['.', '*', ''], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(spawn.mock.calls[0][0].prompt).toBe('');
    });

    it('preserves embedded spaces', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', '*', 'hello world multi word'], createMockCtx());
      expect(spawn.mock.calls[0][0].prompt).toBe('hello world multi word');
    });

    it('preserves newlines', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', '*', 'line1\nline2\nline3'], createMockCtx());
      expect(spawn.mock.calls[0][0].prompt).toBe('line1\nline2\nline3');
    });

    it('preserves Unicode / emoji', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', '*', 'résumé 日本語 🎉'], createMockCtx());
      expect(spawn.mock.calls[0][0].prompt).toBe('résumé 日本語 🎉');
    });

    it('preserves shell metacharacters literally', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      const meta = '$(whoami) `date` && rm -rf /';
      await createAgentCommand().execute(['.', '*', meta], createMockCtx());
      expect(spawn.mock.calls[0][0].prompt).toBe(meta);
    });

    it('treats "-h" as the prompt when in the prompt positional slot', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      const result = await createAgentCommand().execute(['.', '*', '-h'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0][0].prompt).toBe('-h');
    });
  });

  describe('--model flag', () => {
    it('accepts --model in the first position', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(
        ['--model', 'claude-haiku-4-5', '.', '*', 'p'],
        createMockCtx()
      );
      expect(spawn.mock.calls[0][0]).toMatchObject({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'claude-haiku-4-5',
      });
    });

    it('accepts --model in the middle position', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(
        ['.', '--model', 'claude-haiku-4-5', '*', 'p'],
        createMockCtx()
      );
      expect(spawn.mock.calls[0][0].modelId).toBe('claude-haiku-4-5');
    });

    it('accepts --model after the positional args', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(
        ['.', '*', 'p', '--model', 'claude-haiku-4-5'],
        createMockCtx()
      );
      expect(spawn.mock.calls[0][0].modelId).toBe('claude-haiku-4-5');
    });

    it('does NOT pass modelId when --model is absent', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      const call = spawn.mock.calls[0][0];
      expect(call.modelId).toBeUndefined();
    });

    it('errors when --model has no value', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(['--model'], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/--model/);
      expect(bridge).not.toHaveBeenCalled();
    });

    it('errors when --model has a flag-looking value', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(
        ['--model', '--help', '.', '*', 'p'],
        createMockCtx()
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/--model/);
      expect(bridge).not.toHaveBeenCalled();
    });

    it('errors when --model value is empty string', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      const result = await createAgentCommand().execute(
        ['--model', '', '.', '*', 'p'],
        createMockCtx()
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/--model/);
      expect(bridge).not.toHaveBeenCalled();
    });

    it('forwards model id byte-for-byte without normalization', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'x', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(
        ['--model', 'WeIrD-Model_ID.42', '.', '*', 'p'],
        createMockCtx()
      );
      expect(spawn.mock.calls[0][0].modelId).toBe('WeIrD-Model_ID.42');
    });
  });

  describe('bridge output handling', () => {
    it('writes finalText with one trailing newline on exit 0', async () => {
      installBridge(async () => ({ finalText: 'hello', exitCode: 0 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('hello\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('preserves internal newlines and normalizes to one trailing newline', async () => {
      installBridge(async () => ({ finalText: 'line1\nline2\nline3', exitCode: 0 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('line1\nline2\nline3\n');
    });

    it('does not double the trailing newline when finalText already ends with one', async () => {
      installBridge(async () => ({ finalText: 'hello\n', exitCode: 0 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('hello\n');
    });

    it('collapses multiple trailing newlines to one', async () => {
      installBridge(async () => ({ finalText: 'hello\n\n\n', exitCode: 0 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('hello\n');
    });

    it('preserves whitespace-only finalText without trimming spaces', async () => {
      installBridge(async () => ({ finalText: '   ', exitCode: 0 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('   \n');
    });

    it('preserves Unicode in finalText', async () => {
      installBridge(async () => ({ finalText: 'résumé 日本語 🎉', exitCode: 0 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('résumé 日本語 🎉\n');
    });

    it('handles empty finalText as just "\\n" on exit 0', async () => {
      installBridge(async () => ({ finalText: '', exitCode: 0 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('handles null finalText as just "\\n" on exit 0', async () => {
      installBridge(async () => ({ finalText: null, exitCode: 0 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('\n');
      expect(result.exitCode).toBe(0);
    });

    it('handles undefined finalText as just "\\n" on exit 0', async () => {
      installBridge(async () => ({ exitCode: 0 }) as SpawnResult);
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('\n');
      expect(result.exitCode).toBe(0);
    });

    it('writes finalText to stderr on exit 1 and leaves stdout empty', async () => {
      installBridge(async () => ({ finalText: 'boom', exitCode: 1 }));
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('boom');
      expect(result.exitCode).toBe(1);
    });

    it('surfaces bridge promise rejection on stderr with non-zero exit', async () => {
      installBridge(async () => {
        throw new Error('bridge blew up');
      });
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('bridge blew up');
      expect(result.stdout).toBe('');
    });

    it('blocks until the bridge promise resolves', async () => {
      const order: string[] = [];
      let resolveSpawn!: (value: SpawnResult) => void;
      const spawnPromise = new Promise<SpawnResult>((resolve) => {
        resolveSpawn = resolve;
      });
      installBridge(async () => {
        order.push('spawn-start');
        const r = await spawnPromise;
        order.push('spawn-end');
        return r;
      });
      const exec = createAgentCommand()
        .execute(['.', '*', 'p'], createMockCtx())
        .then((r) => {
          order.push('execute-resolved');
          return r;
        });
      // Let the spawn microtask run
      await Promise.resolve();
      expect(order).toContain('spawn-start');
      expect(order).not.toContain('execute-resolved');
      resolveSpawn({ finalText: 'done', exitCode: 0 });
      const result = await exec;
      expect(order.at(-1)).toBe('execute-resolved');
      expect(result.stdout).toBe('done\n');
    });

    it('invokes bridge exactly once on the happy path with the expected shape', async () => {
      const spawn = vi.fn().mockResolvedValue({ finalText: 'ok', exitCode: 0 });
      installBridge(spawn);
      await createAgentCommand().execute(
        ['--model', 'claude-haiku-4-5', '/abs', 'ls,wc', 'do it'],
        createMockCtx('/home')
      );
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0][0]).toEqual({
        cwd: '/abs',
        allowedCommands: ['ls', 'wc'],
        prompt: 'do it',
        modelId: 'claude-haiku-4-5',
      });
    });

    // VAL-OUTPUT-016 scenario A end-to-end: the user's repro pipes stdout
    // through the agent command, expecting the final assistant-text summary
    // rather than the earlier `send_message("Starting.")` progress update.
    it('scenario A: writes the final assistant text (not an earlier send_message) to stdout', async () => {
      installBridge(async () => ({ finalText: 'Summary.', exitCode: 0 }));
      const result = await createAgentCommand().execute(
        [
          '.',
          '*',
          'First write Starting. in chat. Then run bash. Then summarize as the scoop result.',
        ],
        createMockCtx()
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Summary.\n');
      expect(result.stderr).toBe('');
    });
  });

  describe('missing bridge', () => {
    it('errors gracefully when globalThis.__slicc_agent is undefined', async () => {
      clearBridge();
      const result = await createAgentCommand().execute(['.', '*', 'p'], createMockCtx());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/bridge not available/i);
      expect(result.stdout).toBe('');
    });

    it('does NOT call bridge when parse errors short-circuit', async () => {
      const bridge = vi.fn();
      installBridge(bridge);
      await createAgentCommand().execute(['--unknown'], createMockCtx());
      expect(bridge).not.toHaveBeenCalled();
    });
  });
});
