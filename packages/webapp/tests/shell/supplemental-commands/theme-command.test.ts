import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createThemeCommand } from '../../../src/shell/supplemental-commands/theme-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const hoisted = vi.hoisted(() => ({
  client: null as { call: ReturnType<typeof vi.fn> } | null,
}));

vi.mock('../../../src/kernel/panel-rpc.js', () => ({
  getPanelRpcClient: () => hoisted.client,
}));

function withClient(callImpl?: (...args: unknown[]) => unknown) {
  const call = vi.fn(callImpl ?? (async () => ({ applied: 'Vanilla' })));
  hoisted.client = { call };
  return call;
}

const validTheme = JSON.stringify({
  id: 'custom',
  name: 'Custom',
  base: 'dark',
  tokens: { '--s2-gray-25': '#000' },
});

describe('theme command', () => {
  beforeEach(() => {
    hoisted.client = null;
  });

  it('has correct name', () => {
    expect(createThemeCommand().name).toBe('theme');
  });

  it('shows help with no args, --help, and -h', async () => {
    const cmd = createThemeCommand();
    for (const args of [[], ['--help'], ['-h']]) {
      const result = await cmd.execute(args, mockCommandContext());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: theme');
    }
  });

  it('lists presets', async () => {
    const result = await createThemeCommand().execute(['list'], mockCommandContext());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Presets:');
    expect(result.stdout).toContain('vanilla');
  });

  it('reports where to see the current theme', async () => {
    const result = await createThemeCommand().execute(['current'], mockCommandContext());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Theme settings dialog');
  });

  it('errors on an unknown subcommand', async () => {
    const result = await createThemeCommand().execute(['bogus'], mockCommandContext());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand "bogus"');
  });

  describe('reset', () => {
    it('errors without a panel-RPC connection', async () => {
      const result = await createThemeCommand().execute(['reset'], mockCommandContext());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no panel-RPC connection');
    });

    it('resets to the default theme via panel-RPC', async () => {
      const call = withClient();
      const result = await createThemeCommand().execute(['reset'], mockCommandContext());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Theme reset to default.\n');
      expect(call).toHaveBeenCalledWith('theme-apply', { action: 'reset' });
    });
  });

  describe('apply', () => {
    it('errors when no id or path is given', async () => {
      withClient();
      const result = await createThemeCommand().execute(['apply'], mockCommandContext());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('missing theme id or path');
    });

    it('errors without a panel-RPC connection', async () => {
      const result = await createThemeCommand().execute(['apply', 'vanilla'], mockCommandContext());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no panel-RPC connection');
    });

    it('applies a known preset by id', async () => {
      const call = withClient();
      const result = await createThemeCommand().execute(['apply', 'vanilla'], mockCommandContext());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Applied theme: Vanilla\n');
      const [op, payload] = call.mock.calls[0] as [string, { themeJson: string; action: string }];
      expect(op).toBe('theme-apply');
      expect(payload).toMatchObject({ action: 'apply' });
      expect(JSON.parse(payload.themeJson).id).toBe('vanilla');
    });

    it('errors when the target is neither a preset nor an existing file', async () => {
      withClient();
      const ctx = mockCommandContext({
        fs: {
          readFile: (async () => {
            throw new Error('ENOENT');
          }) as IFileSystem['readFile'],
        },
      });
      const result = await createThemeCommand().execute(['apply', 'missing.json'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not a known preset id and file not found');
    });

    it('errors when the file is not valid JSON', async () => {
      withClient();
      const ctx = mockCommandContext({
        fs: { readFile: (async () => 'not json') as IFileSystem['readFile'] },
      });
      const result = await createThemeCommand().execute(['apply', 'bad.json'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not valid JSON');
    });

    it('errors when the theme file is missing required fields', async () => {
      withClient();
      const ctx = mockCommandContext({
        fs: {
          readFile: (async () => JSON.stringify({ id: 'x' })) as IFileSystem['readFile'],
        },
      });
      const result = await createThemeCommand().execute(['apply', 'partial.json'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid theme file');
    });

    it('applies a valid theme file from the VFS', async () => {
      const call = withClient(async () => ({ applied: 'Custom' }));
      const ctx = mockCommandContext({
        fs: { readFile: (async () => validTheme) as IFileSystem['readFile'] },
      });
      const result = await createThemeCommand().execute(['apply', 'custom.json'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Applied theme: Custom\n');
      expect(call).toHaveBeenCalledWith('theme-apply', {
        themeJson: validTheme,
        action: 'apply',
      });
    });
  });

  describe('export', () => {
    it('errors with fewer than two args', async () => {
      const result = await createThemeCommand().execute(
        ['export', 'vanilla'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('usage: theme export');
    });

    it('errors for an unknown preset id', async () => {
      const result = await createThemeCommand().execute(
        ['export', 'nope', '/out.json'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown preset id "nope"');
    });

    it('exports a preset to a VFS path', async () => {
      const writeFile = vi.fn(async () => undefined);
      const ctx = mockCommandContext({
        fs: { writeFile: writeFile as unknown as IFileSystem['writeFile'] },
      });
      const result = await createThemeCommand().execute(['export', 'vanilla', 'theme.json'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Exported "Vanilla" to /home/theme.json');
      const [path, contents] = writeFile.mock.calls[0] as unknown[];
      expect(path).toBe('/home/theme.json');
      expect(JSON.parse(contents as string).id).toBe('vanilla');
    });

    it('surfaces a write failure', async () => {
      const ctx = mockCommandContext({
        fs: {
          writeFile: (async () => {
            throw new Error('disk full');
          }) as unknown as IFileSystem['writeFile'],
        },
      });
      const result = await createThemeCommand().execute(['export', 'vanilla', 'theme.json'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('write failed: disk full');
    });
  });
});
