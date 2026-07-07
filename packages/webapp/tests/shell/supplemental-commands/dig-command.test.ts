import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDigCommand } from '../../../src/shell/supplemental-commands/dig-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const createMockCtx = () => mockCommandContext();

function fetchResponse(status: number, body: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(body);
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 500 ? 'Server Error' : '',
    arrayBuffer: async () => bytes.buffer.slice(0),
    headers: {
      get: (name: string) => lowered[name.toLowerCase()] ?? null,
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
  };
}

const noAnswerBody = JSON.stringify({ Status: 0, Answer: [] });
const aRecordBody = JSON.stringify({
  Status: 0,
  Answer: [
    { name: 'example.com.', type: 1, TTL: 3600, data: '93.184.216.34' },
    { name: 'example.com.', type: 1, TTL: 3600, data: '93.184.216.35' },
  ],
});

describe('dig command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createDigCommand();
    expect(cmd.name).toBe('dig');
  });

  it('shows help with --help', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('usage');
  });

  it('shows help with -h', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['-h'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('usage');
  });

  it('errors when no name provided', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing domain name');
  });

  it('errors on whitespace-only name', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['   '], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing domain name');
  });

  it('errors on unsupported record type', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', 'BOGUS'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported record type: BOGUS');
  });

  it('errors when +short and --json are both supplied', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', '+short', '--json'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('errors on unknown +flag', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', '+trace'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown option: +trace');
  });

  it('errors on unknown --flag', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', '--server'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown option: --server');
  });

  it('queries Cloudflare DoH with default type A and proxied fetch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, aRecordBody));
    vi.stubGlobal('fetch', fetchSpy);

    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const [requestUrl, init] = fetchSpy.mock.calls[0];
    expect(requestUrl).toBe('/api/fetch-proxy');
    expect(init.headers['X-Target-URL']).toBe(
      'https://cloudflare-dns.com/dns-query?name=example.com&type=A'
    );
    expect(init.headers['Accept']).toBe('application/dns-json');
  });

  it('upper-cases the record type in the URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody));
    vi.stubGlobal('fetch', fetchSpy);

    const cmd = createDigCommand();
    await cmd.execute(['example.com', 'aaaa'], createMockCtx());

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Target-URL']).toContain('&type=AAAA');
  });

  it('renders default dig-like answer lines with tabs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, aRecordBody)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com'], createMockCtx());

    expect(result.stdout).toBe(
      'example.com.\t3600\tIN\tA\t93.184.216.34\nexample.com.\t3600\tIN\tA\t93.184.216.35\n'
    );
  });

  it('+short prints one value per line, no headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, aRecordBody)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', '+short'], createMockCtx());

    expect(result.stdout).toBe('93.184.216.34\n93.184.216.35\n');
  });

  it('--json dumps pretty-printed resolver JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, aRecordBody)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', '--json'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.Answer).toHaveLength(2);
    // Pretty-printed with 2-space indent.
    expect(result.stdout).toContain('\n  "Status"');
  });

  it('renders unknown numeric record types as TYPE<n>', async () => {
    const body = JSON.stringify({
      Status: 0,
      Answer: [{ name: 'x.', type: 9999, TTL: 60, data: 'foo' }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, body)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['x'], createMockCtx());
    expect(result.stdout).toContain('TYPE9999');
  });

  it('handles empty Answer array as no-records (default mode)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['nothing.example'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(';; no records found\n');
  });

  it('+short on empty Answer prints nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['nothing.example', '+short'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('maps DoH Status=3 to NXDOMAIN error', async () => {
    const body = JSON.stringify({ Status: 3, Answer: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, body)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['nx.example'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('dig: nx.example: NXDOMAIN\n');
  });

  it('renders unknown rcodes as their numeric value', async () => {
    const body = JSON.stringify({ Status: 42, Answer: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, body)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['x'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: x: 42\n');
  });

  it('fails on non-2xx HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(500, 'oops')));
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('dig: lookup failed: 500');
  });

  it('fails on invalid JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, 'not-json{')));
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid response from resolver');
  });

  it('handles network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: boom\n');
  });

  it('url-encodes the name', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody));
    vi.stubGlobal('fetch', fetchSpy);
    const cmd = createDigCommand();
    await cmd.execute(['weird name.example'], createMockCtx());
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Target-URL']).toContain('name=weird%20name.example');
  });

  it('no-args error mentions usage in stderr', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('usage');
  });

  it('explicit AAAA type lands type=AAAA in the URL and renders AAAA in output', async () => {
    const body = JSON.stringify({
      Status: 0,
      Answer: [{ name: 'example.com.', type: 28, TTL: 300, data: '2606:2800:220:1::1' }],
    });
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, body));
    vi.stubGlobal('fetch', fetchSpy);

    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', 'AAAA'], createMockCtx());

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Target-URL']).toContain('&type=AAAA');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AAAA');
    expect(result.stdout).toContain('2606:2800:220:1::1');
  });

  it('does not call fetch on unsupported record type', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', 'BOGUS'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps DoH Status=2 to SERVFAIL error', async () => {
    const body = JSON.stringify({ Status: 2, Answer: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, body)));
    const cmd = createDigCommand();
    const result = await cmd.execute(['fail.example'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('SERVFAIL');
  });
});
