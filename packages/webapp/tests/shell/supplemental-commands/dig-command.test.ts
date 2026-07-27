import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDigCommand } from '../../../src/shell/supplemental-commands/dig-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const createMockCtx = () => mockCommandContext();

function fetchResponse(
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {}
) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
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

const quad9AResponse = new Uint8Array([
  0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, 7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0,
  0, 1, 0, 1, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 1, 44, 0, 4, 93, 184, 216, 34,
]);

const quad9TxtResponse = new Uint8Array([
  0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, 7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0,
  0, 16, 0, 1, 0xc0, 0x0c, 0, 16, 0, 1, 0, 0, 1, 44, 0, 8, 3, 102, 111, 111, 3, 98, 97, 114,
]);

const quad9TrailingSections = new Uint8Array([
  0xc0, 0x0c, 0, 2, 0, 1, 0, 0, 0, 60, 0, 2, 0xc0, 0x0c, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4,
  1, 1, 1, 1,
]);

function encodeDnsName(name: string): number[] {
  return [
    ...name.split('.').flatMap((label) => [label.length, ...new TextEncoder().encode(label)]),
    0,
  ];
}

function quad9AResponseForName(name: string): Uint8Array {
  return new Uint8Array([
    ...quad9AResponse.slice(0, 12),
    ...encodeDnsName(name),
    ...quad9AResponse.slice(25),
  ]);
}

function quad9ForwardOwnerResponse(): Uint8Array {
  return new Uint8Array([
    ...quad9AResponse.slice(0, 29),
    0xc0,
    0x29,
    0,
    5,
    0,
    1,
    0,
    0,
    1,
    44,
    0,
    13,
    ...encodeDnsName('example.com'),
  ]);
}

function quad9TxtResponseForData(data: number[]): Uint8Array {
  return new Uint8Array([
    ...quad9TxtResponse.slice(0, 39),
    (data.length >> 8) & 0xff,
    data.length & 0xff,
    ...data,
  ]);
}

function quad9ErrorResponse(rcode: number): Uint8Array {
  return new Uint8Array([
    0,
    0,
    0x81,
    0x80 | rcode,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    7,
    101,
    120,
    97,
    109,
    112,
    108,
    101,
    3,
    99,
    111,
    109,
    0,
    0,
    1,
    0,
    1,
  ]);
}

function decodeDnsQuery(encoded: string): Uint8Array {
  const padded = encoded
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

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
    expect(result.stdout).toContain('@server');
    expect(result.stdout).toContain('-x <address>');
    expect(result.stdout).toContain('--version');
    expect(result.stdout).toContain('+opts');
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

  it('errors on an unclassifiable record type', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', 'BOGUS'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "dig: 'BOGUS' is not a valid record type; usage: dig <name> [type] [@server] [+short] [--json]\n"
    );
  });

  it('errors when +short and --json are both supplied', async () => {
    const cmd = createDigCommand();
    const result = await cmd.execute(['example.com', '+short', '--json'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('accepts unknown +flags as no-ops', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody)));
    const cmd = createDigCommand();
    const result = await cmd.execute(
      ['+noall', '+answer', 'example.com', '+trace'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
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

  it.each(['-v', '--version'])('prints the version without resolving: %s', async (arg) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await createDigCommand().execute([arg], createMockCtx());
    expect(result).toEqual({
      stdout: 'DiG 9.20.0-slicc (DNS-over-HTTPS)\n',
      stderr: '',
      exitCode: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts the record type before the name', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody));
    vi.stubGlobal('fetch', fetchSpy);
    await createDigCommand().execute(['AAAA', 'example.com'], createMockCtx());
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Target-URL']).toBe(
      'https://cloudflare-dns.com/dns-query?name=example.com&type=AAAA'
    );
  });

  it('preserves the JSON request path for Google', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await createDigCommand().execute(
      ['example.com', '@8.8.8.8', 'A'],
      createMockCtx()
    );
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Target-URL']).toBe('https://dns.google/resolve?name=example.com&type=A');
    expect(init.headers.Accept).toBe('application/dns-json');
    expect(result.stderr).toBe('');
  });

  it('queries Quad9 with an RFC 8484 DNS-message GET request', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        fetchResponse(200, quad9AResponse, { 'content-type': 'application/dns-message' })
      );
    vi.stubGlobal('fetch', fetchSpy);
    const result = await createDigCommand().execute(
      ['example.com', '@9.9.9.9', 'A'],
      createMockCtx()
    );
    const [, init] = fetchSpy.mock.calls[0];
    const target = new URL(init.headers['X-Target-URL']);
    expect(`${target.origin}${target.pathname}`).toBe('https://dns.quad9.net/dns-query');
    expect(init.headers.Accept).toBe('application/dns-message');
    expect(Array.from(decodeDnsQuery(target.searchParams.get('dns') ?? ''))).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0,
      0, 1, 0, 1,
    ]);
    expect(result).toEqual({
      stdout: 'example.com.\t300\tIN\tA\t93.184.216.34\n',
      stderr: '',
      exitCode: 0,
    });
  });

  it.each([
    ['1.2', '1.2'],
    ['010.0.0.1', '010.0.0.1'],
    ['bücher.example', 'xn--bcher-kva.example'],
  ])('preserves the DNS labels for %s as %s', async (name, wireName) => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, quad9AResponseForName(wireName)));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await createDigCommand().execute([name, '@9.9.9.9', 'A'], createMockCtx());
    const [, init] = fetchSpy.mock.calls[0];
    const target = new URL(init.headers['X-Target-URL']);
    expect(Array.from(decodeDnsQuery(target.searchParams.get('dns') ?? ''))).toEqual([
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      ...encodeDnsName(wireName),
      0,
      1,
      0,
      1,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${wireName}.`);
  });

  it('preserves a percent sequence as literal Quad9 question bytes', async () => {
    const name = 'a%2Eb.example.com';
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, quad9AResponseForName(name)));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await createDigCommand().execute([name, '@9.9.9.9', 'A'], createMockCtx());
    const [, init] = fetchSpy.mock.calls[0];
    const target = new URL(init.headers['X-Target-URL']);
    expect(Array.from(decodeDnsQuery(target.searchParams.get('dns') ?? ''))).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 5, 97, 37, 50, 69, 98, 7, 101, 120, 97, 109, 112, 108,
      101, 3, 99, 111, 109, 0, 0, 1, 0, 1,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${name}.`);
  });

  it('rejects a Quad9 response that splits a literal percent sequence into labels', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fetchResponse(200, quad9AResponseForName('a.b.example.com')))
    );
    const result = await createDigCommand().execute(
      ['a%2Eb.example.com', '@9.9.9.9', 'A'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: invalid response from resolver\n');
  });

  it('accepts a backward compression pointer in a Quad9 answer owner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, quad9AResponse)));
    const result = await createDigCommand().execute(
      ['example.com', '@9.9.9.9', 'A'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('93.184.216.34');
  });

  it('rejects a forward compression pointer in a Quad9 answer owner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fetchResponse(200, quad9ForwardOwnerResponse()))
    );
    const result = await createDigCommand().execute(
      ['example.com', '@9.9.9.9', 'A'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: invalid response from resolver\n');
  });

  it('rejects a self compression pointer in a Quad9 answer owner', async () => {
    const selfPointer = quad9AResponse.slice();
    selfPointer[30] = 29;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, selfPointer)));
    const result = await createDigCommand().execute(
      ['example.com', '@9.9.9.9', 'A'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: invalid response from resolver\n');
  });

  it.each(['bad name.example', 'user@example.com', 'bad/name.example', 'bad?name.example'])(
    'rejects unsafe Quad9 DNS name syntax: %s',
    async (name) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const result = await createDigCommand().execute([name, '@9.9.9.9', 'A'], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(`dig: invalid DNS name: ${name}\n`);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it('accepts a matching Quad9 question case-insensitively with a trailing dot', async () => {
    const uppercaseQuestion = quad9AResponse.slice();
    uppercaseQuestion.set(new TextEncoder().encode('EXAMPLE'), 13);
    uppercaseQuestion.set(new TextEncoder().encode('COM'), 21);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, uppercaseQuestion)));
    const result = await createDigCommand().execute(
      ['ExAmPlE.CoM.', '@9.9.9.9', 'A'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('93.184.216.34');
  });

  it.each([
    ['name', 13, 0x66],
    ['type', 26, 28],
    ['class', 28, 3],
  ])('rejects a mismatched Quad9 question %s', async (_field, offset, value) => {
    const mismatched = quad9AResponse.slice();
    mismatched[offset] = value;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, mismatched)));
    const result = await createDigCommand().execute(['example.com', '@9.9.9.9'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: invalid response from resolver\n');
  });

  it.each([
    [['example.com', '@dns.quad9.net', 'A', '+short'], '93.184.216.34\n'],
    [['example.com', '@149.112.112.112', 'A', '--json'], '"Status": 0'],
  ])('preserves Quad9 output modes for %j', async (args, expectedOutput) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          fetchResponse(200, quad9AResponse, { 'content-type': 'application/dns-message' })
        )
    );
    const result = await createDigCommand().execute(args, createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(expectedOutput);
  });

  it('reports a malformed Quad9 DNS message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fetchResponse(200, new Uint8Array([0, 0, 0x81]), {
          'content-type': 'application/dns-message',
        })
      )
    );
    const result = await createDigCommand().execute(['example.com', '@9.9.9.9'], createMockCtx());
    expect(result).toEqual({
      stdout: '',
      stderr: 'dig: invalid response from resolver\n',
      exitCode: 1,
    });
  });

  it('rejects a truncated Quad9 DNS response even when its answer is complete', async () => {
    const truncated = quad9AResponse.slice();
    truncated[2] |= 0x02;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, truncated)));
    const result = await createDigCommand().execute(['example.com', '@9.9.9.9'], createMockCtx());
    expect(result).toEqual({
      stdout: '',
      stderr: 'dig: invalid response from resolver\n',
      exitCode: 1,
    });
  });

  it.each([
    ['authority', 9],
    ['additional', 11],
  ])('rejects a missing declared Quad9 %s record', async (_section, countOffset) => {
    const incomplete = quad9AResponse.slice();
    incomplete[countOffset] = 1;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, incomplete)));
    const result = await createDigCommand().execute(['example.com', '@9.9.9.9'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: invalid response from resolver\n');
  });

  it('consumes declared Quad9 authority and additional records', async () => {
    const withSections = new Uint8Array([...quad9AResponse, ...quad9TrailingSections]);
    withSections[9] = 1;
    withSections[11] = 1;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, withSections)));
    const result = await createDigCommand().execute(['example.com', '@9.9.9.9'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('93.184.216.34');
  });

  it('rejects trailing data outside declared Quad9 sections', async () => {
    const withTrailingByte = new Uint8Array([...quad9AResponse, 0]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, withTrailingByte)));
    const result = await createDigCommand().execute(['example.com', '@9.9.9.9'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: invalid response from resolver\n');
  });

  it.each([
    [[], 'example.com.\t300\tIN\tTXT\t"foo" "bar"\n'],
    [['+short'], '"foo" "bar"\n'],
    [['--json'], '"data": "\\"foo\\" \\"bar\\""'],
  ])('preserves Quad9 TXT segments for output mode %j', async (options, expectedOutput) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, quad9TxtResponse)));
    const result = await createDigCommand().execute(
      ['example.com', 'TXT', '@9.9.9.9', ...options],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(expectedOutput);
  });

  it.each([
    [[], '\tTXT\t' + String.raw`"\"\\\001\255" "\239\191\189"` + '\n'],
    [['+short'], String.raw`"\"\\\001\255" "\239\191\189"` + '\n'],
  ])('escapes arbitrary Quad9 TXT bytes for output mode %j', async (options, expectedOutput) => {
    const response = quad9TxtResponseForData([4, 0x22, 0x5c, 0x01, 0xff, 3, 0xef, 0xbf, 0xbd]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, response)));
    const result = await createDigCommand().execute(
      ['example.com', 'TXT', '@9.9.9.9', ...options],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(expectedOutput);
  });

  it('preserves arbitrary Quad9 TXT bytes in JSON output', async () => {
    const response = quad9TxtResponseForData([4, 0x22, 0x5c, 0x01, 0xff, 3, 0xef, 0xbf, 0xbd]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(200, response)));
    const result = await createDigCommand().execute(
      ['example.com', 'TXT', '@9.9.9.9', '--json'],
      createMockCtx()
    );
    const payload = JSON.parse(result.stdout) as { Answer: Array<{ data: string }> };
    expect(payload.Answer[0].data).toBe(String.raw`"\"\\\001\255" "\239\191\189"`);
  });

  it('maps a Quad9 DNS error response to the existing error output', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          fetchResponse(200, quad9ErrorResponse(3), { 'content-type': 'application/dns-message' })
        )
    );
    const result = await createDigCommand().execute(['example.com', '@9.9.9.9'], createMockCtx());
    expect(result).toEqual({ stdout: '', stderr: 'dig: example.com: NXDOMAIN\n', exitCode: 1 });
  });

  it('reports a Quad9 HTTP error before parsing its body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(500, 'oops')));
    const result = await createDigCommand().execute(['example.com', '@9.9.9.9'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('dig: lookup failed: 500 Server Error\n');
  });

  it('uses the default resolver and prints a note for an unsupported @server', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await createDigCommand().execute(
      ['@ns.example.com', 'example.com'],
      createMockCtx()
    );
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Target-URL']).toBe(
      'https://cloudflare-dns.com/dns-query?name=example.com&type=A'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      'dig: note: @ns.example.com not supported over DoH; using cloudflare-dns.com\n'
    );
  });

  it.each([
    ['8.8.8.8', '8.8.8.8.in-addr.arpa'],
    ['2001:db8::1', '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa'],
  ])('issues a PTR query for -x %s', async (address, reverseName) => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchResponse(200, noAnswerBody));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await createDigCommand().execute(['-x', address], createMockCtx());
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Target-URL']).toBe(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(reverseName)}&type=PTR`
    );
    expect(result.exitCode).toBe(0);
  });

  it('rejects an invalid -x address without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await createDigCommand().execute(['-x', 'not-an-ip'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("dig: 'not-an-ip' is not a valid IP address for -x\n");
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(result.stderr).toContain("'BOGUS' is not a valid record type");
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
