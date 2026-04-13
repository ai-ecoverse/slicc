import { describe, expect, it, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import { createManCommand } from '../../../src/shell/supplemental-commands/man-command.js';

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

describe('man command', () => {
  it('has correct name', () => {
    const cmd = createManCommand();
    expect(cmd.name).toBe('man');
  });

  it('shows help with --help', async () => {
    const cmd = createManCommand();
    const result = await cmd.execute(['--help'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('usage');
  });

  it('shows help with -h', async () => {
    const cmd = createManCommand();
    const result = await cmd.execute(['-h'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('usage');
  });

  it('returns error when no topic provided', async () => {
    const cmd = createManCommand();
    const result = await cmd.execute([], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('What manual page do you want?');
  });

  it('fetches and returns plain text for valid topic', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: '<h1>Commands</h1><p>List of commands</p>',
      headers: {},
      url: '',
    });

    const cmd = createManCommand(mockFetch);
    const result = await cmd.execute(['bash'], createMockCtx());

    expect(result.exitCode).toBe(0);
    // HTML should be stripped
    expect(result.stdout).not.toContain('<h1>');
    expect(result.stdout).not.toContain('<p>');
    expect(result.stdout).not.toContain('</');
    expect(result.stdout).toContain('Commands');
    expect(result.stdout).toContain('List of commands');
  });

  it('returns error for 404 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      statusText: 'Not Found',
      body: 'Not found',
      headers: {},
      url: '',
    });

    const cmd = createManCommand(mockFetch);
    const result = await cmd.execute(['nonexistent'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No manual entry for');
  });

  it('handles network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const cmd = createManCommand(mockFetch);
    const result = await cmd.execute(['bash'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('strips HTML entities', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: '<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</p>',
      headers: {},
      url: '',
    });

    const cmd = createManCommand(mockFetch);
    const result = await cmd.execute(['test'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('A & B');
    expect(result.stdout).toContain('< C >');
    expect(result.stdout).toContain('"E"');
    expect(result.stdout).toContain("'F'");
    // No raw entities remaining
    expect(result.stdout).not.toContain('&amp;');
    expect(result.stdout).not.toContain('&lt;');
    expect(result.stdout).not.toContain('&gt;');
    expect(result.stdout).not.toContain('&quot;');
    expect(result.stdout).not.toContain('&#39;');
  });
});
