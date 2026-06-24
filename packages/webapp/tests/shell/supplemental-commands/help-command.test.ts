import type { IFileSystem } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { createCommandsCommand } from '../../../src/shell/supplemental-commands/help-command.js';

function createMockCtx(registeredCommands: string[]) {
  return {
    fs: {
      resolvePath: (base: string, path: string) =>
        path.startsWith('/') ? path : `${base}/${path}`,
    } as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
    getRegisteredCommands: () => registeredCommands,
  };
}

/** Find the line that immediately follows the given category header. */
function lineAfterCategory(stdout: string, category: string): string | undefined {
  const lines = stdout.split('\n');
  const idx = lines.findIndex((l) => l.trim() === `${category}:`);
  return idx >= 0 ? lines[idx + 1] : undefined;
}

/**
 * Canonical default-install built-in surface. Mirrors the categories declared
 * in COMMAND_CATEGORIES so the "Other" bucket assertion catches anything that
 * slips through uncategorized. Dynamic aliases (mcp:<name> shims) and obvious
 * typos (e.g. `sqllite`) are intentionally omitted.
 */
const DEFAULT_BUILTIN_COMMANDS = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'touch',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'ln',
  'chmod',
  'stat',
  'readlink',
  'file',
  'rmdir',
  'rsync',
  'grep',
  'sed',
  'awk',
  'sort',
  'uniq',
  'cut',
  'tr',
  'tee',
  'diff',
  'column',
  'comm',
  'egrep',
  'fgrep',
  'expand',
  'unexpand',
  'fold',
  'join',
  'nl',
  'od',
  'paste',
  'rev',
  'split',
  'strings',
  'tac',
  'find',
  'rg',
  'pwd',
  'basename',
  'dirname',
  'tree',
  'du',
  'cd',
  'zip',
  'unzip',
  'pdftk',
  'pdf',
  'gunzip',
  'gzip',
  'zcat',
  'convert',
  'magick',
  'ffmpeg',
  'screencapture',
  'say',
  'afplay',
  'chime',
  'echo',
  'printf',
  'env',
  'printenv',
  'export',
  'alias',
  'unalias',
  'history',
  'clear',
  'true',
  'false',
  'bash',
  'sh',
  'commands',
  'which',
  'uname',
  'man',
  'host',
  'oauth-token',
  'secret',
  'nuke',
  'models',
  'local-llm',
  'cost',
  'hostname',
  'whoami',
  'help',
  'sleep',
  'time',
  'timeout',
  'oauth-domain',
  'xargs',
  'jq',
  'base64',
  'date',
  'expr',
  'seq',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'curl',
  'wget',
  'dig',
  'websocat',
  'html-to-markdown',
  'git',
  'node',
  'python',
  'python3',
  'sqlite3',
  'tsc',
  'test',
  'esbuild',
  'biome',
  'skill',
  'upskill',
  'serve',
  'open',
  'imgcat',
  'sprinkle',
  'pbcopy',
  'pbpaste',
  'xclip',
  'xsel',
  'mount',
  'fswatch',
  'agent',
  'mcp',
  'webhook',
  'crontask',
  'ps',
  'kill',
];

describe('commands command', () => {
  it('has correct name', () => {
    const cmd = createCommandsCommand();
    expect(cmd.name).toBe('commands');
  });

  it('shows help with --help', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute(['--help'], createMockCtx([]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('display available commands');
  });

  it('lists both agent and mcp under Scoops & agents when mcp is registered', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute([], createMockCtx(['ls', 'cat', 'agent', 'mcp']));
    expect(result.exitCode).toBe(0);
    const cmdsLine = lineAfterCategory(result.stdout, 'Scoops & agents');
    expect(cmdsLine).toBeDefined();
    expect(cmdsLine).toContain('agent');
    expect(cmdsLine).toContain('mcp');
  });

  it('omits mcp from Scoops & agents when mcp is not registered', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute([], createMockCtx(['ls', 'cat', 'agent']));
    expect(result.exitCode).toBe(0);
    const cmdsLine = lineAfterCategory(result.stdout, 'Scoops & agents');
    expect(cmdsLine).toBeDefined();
    expect(cmdsLine).toContain('agent');
    expect(cmdsLine).not.toContain('mcp');
  });

  it('does not create a standalone MCP category', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute([], createMockCtx(['ls', 'cat', 'agent', 'mcp']));
    expect(result.stdout).not.toContain('MCP:');
  });

  it('lists md5sum, sha1sum, sha256sum under Hashes', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute([], createMockCtx(['ls', 'md5sum', 'sha1sum', 'sha256sum']));
    expect(result.exitCode).toBe(0);
    const cmdsLine = lineAfterCategory(result.stdout, 'Hashes');
    expect(cmdsLine).toBeDefined();
    expect(cmdsLine).toContain('md5sum');
    expect(cmdsLine).toContain('sha1sum');
    expect(cmdsLine).toContain('sha256sum');
  });

  it('lists pbcopy, pbpaste, xclip, xsel under Clipboard', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute(
      [],
      createMockCtx(['ls', 'pbcopy', 'pbpaste', 'xclip', 'xsel'])
    );
    expect(result.exitCode).toBe(0);
    const cmdsLine = lineAfterCategory(result.stdout, 'Clipboard');
    expect(cmdsLine).toBeDefined();
    expect(cmdsLine).toContain('pbcopy');
    expect(cmdsLine).toContain('pbpaste');
    expect(cmdsLine).toContain('xclip');
    expect(cmdsLine).toContain('xsel');
  });

  it('places webhook under Scoops & agents, not Browser & UI', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute([], createMockCtx(['ls', 'webhook', 'open']));
    expect(result.exitCode).toBe(0);
    const scoopsLine = lineAfterCategory(result.stdout, 'Scoops & agents');
    expect(scoopsLine).toBeDefined();
    expect(scoopsLine).toContain('webhook');
    const browserLine = lineAfterCategory(result.stdout, 'Browser & UI');
    expect(browserLine ?? '').not.toContain('webhook');
  });

  it('has no Other section for the default built-in surface', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute([], createMockCtx(DEFAULT_BUILTIN_COMMANDS));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Other:');
  });

  it('groups tsc/test/esbuild/biome under Build tools', async () => {
    const cmd = createCommandsCommand();
    const result = await cmd.execute([], createMockCtx(['ls', 'tsc', 'test', 'esbuild', 'biome']));
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n');
    const idx = lines.findIndex((l) => l.includes('Build tools:'));
    expect(idx).toBeGreaterThan(-1);
    const listing = (lines[idx + 1] ?? '').trim();
    expect(listing).toContain('tsc');
    expect(listing).toContain('test');
    expect(listing).toContain('esbuild');
    expect(listing).toContain('biome');
  });

  it('lists workflow commands under a Workflows section', async () => {
    const cmd = createCommandsCommand({
      getWorkflowCommands: async () => ['audit', 'triage:sweep'],
    });
    const ctx: any = { cwd: '/', env: new Map(), getRegisteredCommands: () => ['ls'] };
    const res = await cmd.execute([], ctx);
    expect(res.stdout).toMatch(/Workflows:/);
    expect(res.stdout).toContain('audit');
    expect(res.stdout).toContain('triage:sweep');
  });
});
