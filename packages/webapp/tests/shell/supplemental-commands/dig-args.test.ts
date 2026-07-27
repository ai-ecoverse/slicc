import { describe, expect, it } from 'vitest';
import { parseDigArgs } from '../../../src/shell/supplemental-commands/dig-args.js';

function query(args: string[]) {
  const parsed = parseDigArgs(args);
  expect(parsed.kind).toBe('query');
  if (parsed.kind !== 'query') throw new Error('expected parsed query');
  return parsed;
}

describe('dig argument parser', () => {
  it.each([
    [['A', 'example.com'], 'A'],
    [['example.com', 'a'], 'A'],
    [['+short', 'NS', 'example.com'], 'NS'],
  ])('classifies name and type independent of order: %j', (args, type) => {
    expect(query(args)).toMatchObject({ name: 'example.com', type });
  });

  it.each([
    ['1.1.1.1', 'https://cloudflare-dns.com/dns-query'],
    ['1.0.0.1', 'https://cloudflare-dns.com/dns-query'],
    ['cloudflare-dns.com', 'https://cloudflare-dns.com/dns-query'],
    ['8.8.8.8', 'https://dns.google/resolve'],
    ['8.8.4.4', 'https://dns.google/resolve'],
    ['dns.google', 'https://dns.google/resolve'],
    ['9.9.9.9', 'https://dns.quad9.net:5053/dns-query'],
    ['149.112.112.112', 'https://dns.quad9.net:5053/dns-query'],
    ['dns.quad9.net', 'https://dns.quad9.net:5053/dns-query'],
  ])('maps @%s to its DoH endpoint', (server, resolverUrl) => {
    expect(query([`@${server}`, 'example.com'])).toMatchObject({ resolverUrl, fallbackNote: '' });
  });

  it('falls back to Cloudflare for an unsupported @server', () => {
    expect(query(['example.com', '@ns.example.com'])).toMatchObject({
      resolverUrl: 'https://cloudflare-dns.com/dns-query',
      fallbackNote: 'dig: note: @ns.example.com not supported over DoH; using cloudflare-dns.com\n',
    });
  });

  it.each(['-v', '--version'])('recognizes the version option: %s', (arg) => {
    expect(parseDigArgs([arg])).toEqual({ kind: 'version' });
  });

  it('builds an IPv4 reverse lookup', () => {
    expect(query(['-x', '8.8.4.4'])).toMatchObject({
      name: '4.4.8.8.in-addr.arpa',
      type: 'PTR',
    });
  });

  it('builds a nibble-reversed IPv6 lookup', () => {
    expect(query(['-x', '2001:db8::1'])).toMatchObject({
      name: '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa',
      type: 'PTR',
    });
  });

  it('rejects an invalid reverse lookup address', () => {
    expect(parseDigArgs(['-x', '999.1.2.3'])).toEqual({
      kind: 'error',
      message: "dig: '999.1.2.3' is not a valid IP address for -x\n",
    });
  });

  it('accepts unknown +options as no-ops while preserving +short', () => {
    expect(query(['+noall', '+answer', '+trace', 'example.com', '+short'])).toMatchObject({
      name: 'example.com',
      short: true,
    });
  });

  it('reports an unclassifiable token with the dig-compatible usage', () => {
    expect(parseDigArgs(['example.com', 'BOGUS'])).toEqual({
      kind: 'error',
      message:
        "dig: 'BOGUS' is not a valid record type; usage: dig <name> [type] [@server] [+short] [--json]\n",
    });
  });

  it('treats a lone unknown bare token as the query name', () => {
    expect(query(['notatype'])).toMatchObject({ name: 'notatype', type: 'A' });
  });

  it('errors clearly when name and type slots are already filled', () => {
    expect(parseDigArgs(['example.com', 'A', 'extra'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining("'extra' is not a valid record type"),
    });
  });
});
