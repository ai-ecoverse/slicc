/**
 * Flag-parsing and help behaviour for `discover`. Fetch routing is covered
 * in `tests/net/discover-links.test.ts`; these tests stay cheap and mock
 * the proxied fetch only when a happy path needs a response.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const hoisted = vi.hoisted(() => ({
  proxied: vi.fn(async (_url: string, _options?: unknown) => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
  })),
}));

vi.mock('../../../src/shell/proxied-fetch.js', () => ({
  createProxiedFetch: () => hoisted.proxied,
}));

import { createDiscoverCommand } from '../../../src/shell/supplemental-commands/discover-command.js';

describe('discover command', () => {
  beforeEach(() => {
    hoisted.proxied.mockClear();
    hoisted.proxied.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '',
    });
  });

  it('shows help with no args, --help, and -h', async () => {
    const cmd = createDiscoverCommand();
    for (const args of [[], ['--help'], ['-h']]) {
      const result = await cmd.execute(args, mockCommandContext());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('discover — fetch a URL');
    }
    expect(hoisted.proxied).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag instead of ignoring it', async () => {
    // Previously `args.filter((a) => !a.startsWith('-'))` dropped `--bogus`
    // and exited 0 after fetching the URL (issue #2255).
    const result = await createDiscoverCommand().execute(
      ['--bogus', 'https://example.com/'],
      mockCommandContext()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag: --bogus');
    expect(hoisted.proxied).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag after the URL (any-position)', async () => {
    const result = await createDiscoverCommand().execute(
      ['https://example.com/', '--json'],
      mockCommandContext()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag: --json');
    expect(hoisted.proxied).not.toHaveBeenCalled();
  });

  it('accepts --follow before or after the URL', async () => {
    for (const args of [
      ['--follow', 'https://example.com/'],
      ['https://example.com/', '--follow'],
    ]) {
      hoisted.proxied.mockClear();
      const result = await createDiscoverCommand().execute(args, mockCommandContext());
      expect(result.exitCode).toBe(0);
      expect(hoisted.proxied).toHaveBeenCalledWith('https://example.com/', { method: 'GET' });
      const body = JSON.parse(result.stdout) as { url: string };
      expect(body.url).toBe('https://example.com/');
    }
  });

  it('honours -- so a dash-prefixed URL stays positional', async () => {
    const result = await createDiscoverCommand().execute(
      ['--', '--not-a-flag.example'],
      mockCommandContext()
    );
    expect(result.exitCode).toBe(0);
    expect(hoisted.proxied).toHaveBeenCalledWith('--not-a-flag.example', { method: 'GET' });
  });

  it('does not treat --help after -- as a help request', async () => {
    const result = await createDiscoverCommand().execute(['--', '--help'], mockCommandContext());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Usage:');
    expect(hoisted.proxied).toHaveBeenCalledWith('--help', { method: 'GET' });
  });

  it('errors when the URL argument is missing', async () => {
    const result = await createDiscoverCommand().execute(['--follow'], mockCommandContext());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('expected exactly one URL argument');
    expect(hoisted.proxied).not.toHaveBeenCalled();
  });
});
