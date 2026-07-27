export const DEFAULT_RESOLVER_URL = 'https://cloudflare-dns.com/dns-query';
export const DIG_USAGE = 'usage: dig <name> [type] [@server] [+short] [--json]';
export const DIG_VERSION = 'DiG 9.20.0-slicc (DNS-over-HTTPS)';

export const SUPPORTED_TYPES = [
  'A',
  'AAAA',
  'MX',
  'TXT',
  'CNAME',
  'NS',
  'SOA',
  'SRV',
  'PTR',
  'CAA',
];

const RESOLVER_URLS: Record<string, string> = {
  '1.1.1.1': DEFAULT_RESOLVER_URL,
  '1.0.0.1': DEFAULT_RESOLVER_URL,
  'cloudflare-dns.com': DEFAULT_RESOLVER_URL,
  '8.8.8.8': 'https://dns.google/resolve',
  '8.8.4.4': 'https://dns.google/resolve',
  'dns.google': 'https://dns.google/resolve',
  '9.9.9.9': 'https://dns.quad9.net:5053/dns-query',
  '149.112.112.112': 'https://dns.quad9.net:5053/dns-query',
  'dns.quad9.net': 'https://dns.quad9.net:5053/dns-query',
};

export interface DigQueryArgs {
  kind: 'query';
  name: string;
  type: string;
  short: boolean;
  json: boolean;
  resolverUrl: string;
  fallbackNote: string;
}

export type DigArgsResult = DigQueryArgs | { kind: 'version' } | { kind: 'error'; message: string };

interface ParserState {
  name?: string;
  type?: string;
  server?: string;
  short: boolean;
  json: boolean;
}

type ParseStep = { nextIndex: number } | { error: DigArgsResult };

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (
    parts.some((part) => !/^[0-9]+$/.test(part)) ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined;
  }
  return octets;
}

function ipv6Words(address: string): string[] | undefined {
  if (address.includes('.') || address.includes('%')) return undefined;
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = [...left, ...right];
  if (words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return undefined;
  if (halves.length === 1) return words.length === 8 ? words : undefined;
  if (words.length >= 8) return undefined;
  return [...left, ...Array<string>(8 - words.length).fill('0'), ...right];
}

function reverseLookupName(address: string): string | undefined {
  const ipv4 = parseIpv4(address);
  if (ipv4) return `${ipv4.reverse().join('.')}.in-addr.arpa`;

  const words = ipv6Words(address);
  if (!words) return undefined;
  const nibbles = words
    .map((word) => word.padStart(4, '0'))
    .join('')
    .split('')
    .reverse();
  return `${nibbles.join('.')}.ip6.arpa`;
}

function invalidType(token: string): DigArgsResult {
  return {
    kind: 'error',
    message: `dig: '${token}' is not a valid record type; ${DIG_USAGE}\n`,
  };
}

function parseReverse(args: string[], index: number, state: ParserState): ParseStep {
  const address = args[index + 1]?.trim();
  if (!address) return { error: { kind: 'error', message: 'dig: -x requires an address\n' } };
  const reverseName = reverseLookupName(address);
  if (!reverseName) {
    return {
      error: { kind: 'error', message: `dig: '${address}' is not a valid IP address for -x\n` },
    };
  }
  if (state.name) return { error: invalidType(address) };
  state.name = reverseName;
  state.type = 'PTR';
  return { nextIndex: index + 1 };
}

function parseServer(arg: string, index: number, state: ParserState): ParseStep {
  if (state.server) {
    return { error: { kind: 'error', message: 'dig: multiple @server arguments\n' } };
  }
  state.server = arg.slice(1).trim();
  if (!state.server) {
    return { error: { kind: 'error', message: 'dig: empty @server argument\n' } };
  }
  return { nextIndex: index };
}

function parseBare(arg: string, index: number, state: ParserState): ParseStep {
  const token = arg.trim();
  const candidateType = token.toUpperCase();
  if (SUPPORTED_TYPES.includes(candidateType) && !state.type) state.type = candidateType;
  else if (!state.name) state.name = token;
  else return { error: invalidType(token) };
  return { nextIndex: index };
}

function parseArgument(args: string[], index: number, state: ParserState): ParseStep {
  const arg = args[index];
  if (arg.startsWith('+')) {
    if (arg === '+short') state.short = true;
    return { nextIndex: index };
  }
  if (arg === '--json') {
    state.json = true;
    return { nextIndex: index };
  }
  if (arg === '-x') return parseReverse(args, index, state);
  if (arg.startsWith('@')) return parseServer(arg, index, state);
  if (arg.startsWith('-')) {
    return { error: { kind: 'error', message: `dig: unknown option: ${arg}\n` } };
  }
  return parseBare(arg, index, state);
}

function buildQuery(state: ParserState): DigArgsResult {
  if (state.short && state.json) {
    return { kind: 'error', message: 'dig: +short and --json are mutually exclusive\n' };
  }
  if (!state.name) {
    return { kind: 'error', message: `dig: missing domain name\n${DIG_USAGE}\n` };
  }

  const normalizedServer = state.server?.toLowerCase();
  const resolverUrl = normalizedServer ? RESOLVER_URLS[normalizedServer] : undefined;
  const fallbackNote =
    state.server && !resolverUrl
      ? `dig: note: @${state.server} not supported over DoH; using cloudflare-dns.com\n`
      : '';
  return {
    kind: 'query',
    name: state.name,
    type: state.type ?? 'A',
    short: state.short,
    json: state.json,
    resolverUrl: resolverUrl ?? DEFAULT_RESOLVER_URL,
    fallbackNote,
  };
}

export function parseDigArgs(args: string[]): DigArgsResult {
  if (args.includes('-v') || args.includes('--version')) return { kind: 'version' };
  const state: ParserState = { short: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const step = parseArgument(args, index, state);
    if ('error' in step) return step.error;
    index = step.nextIndex;
  }
  return buildQuery(state);
}
