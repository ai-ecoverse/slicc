import { describe, it, expect } from 'vitest';
import { createCommandsCommand } from '../../../src/shell/supplemental-commands/help-command.js';
import type { IFileSystem } from 'just-bash';

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
});
