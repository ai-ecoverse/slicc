import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Build a minimal `Response`-shaped mock that satisfies what
 * `createProxiedFetch` reads: `arrayBuffer`, `headers.get`,
 * `headers.forEach`, and the status fields. The man command goes
 * through proxied-fetch (same path as `curl`) so the request can
 * reach `sliccy.com` from the kernel-worker without CORS.
 */
function fetchResponse(status: number, body: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(body);
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : '',
    arrayBuffer: async () => bytes.buffer.slice(0),
    headers: {
      get: (name: string) => lowered[name.toLowerCase()] ?? null,
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
  };
}

describe('man command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fetchResponse(200, '<h1>Commands</h1><p>List of commands</p>'))
    );

    const cmd = createManCommand();
    const result = await cmd.execute(['bash'], createMockCtx());

    expect(result.exitCode).toBe(0);
    // HTML should be stripped
    expect(result.stdout).not.toContain('<h1>');
    expect(result.stdout).not.toContain('<p>');
    expect(result.stdout).not.toContain('</');
    expect(result.stdout).toContain('Commands');
    expect(result.stdout).toContain('List of commands');
  });

  it('routes through /api/fetch-proxy in CLI mode', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, '<p>ok</p>'));
    vi.stubGlobal('fetch', fetchSpy);

    const cmd = createManCommand();
    await cmd.execute(['bash'], createMockCtx());

    // The first argument to fetch should be the proxy endpoint, with
    // the real target URL passed in the X-Target-URL header.
    const [requestUrl, init] = fetchSpy.mock.calls[0];
    expect(requestUrl).toBe('/api/fetch-proxy');
    expect(init.headers['X-Target-URL']).toBe('https://www.sliccy.com/man/bash.plain.html');
  });

  it('joins multi-word topics with hyphens in the URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, '<p>ok</p>'));
    vi.stubGlobal('fetch', fetchSpy);

    const cmd = createManCommand();
    await cmd.execute(['file', 'system'], createMockCtx());

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Target-URL']).toBe('https://www.sliccy.com/man/file-system.plain.html');
  });

  it('returns error for 404 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(404, 'Not found')));

    const cmd = createManCommand();
    const result = await cmd.execute(['nonexistent'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No manual entry for');
  });

  it('handles network errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    const cmd = createManCommand();
    const result = await cmd.execute(['bash'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('strips HTML entities', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          fetchResponse(200, '<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</p>')
        )
    );

    const cmd = createManCommand();
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
