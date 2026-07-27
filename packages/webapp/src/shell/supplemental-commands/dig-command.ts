import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createProxiedFetch } from '../proxied-fetch.js';
import {
  DIG_VERSION,
  type DigQueryArgs,
  parseDigArgs,
  QUAD9_RESOLVER_URL,
  SUPPORTED_TYPES,
} from './dig-args.js';
import { buildDnsMessageUrl, type DnsResponse, parseDnsMessage } from './dns-message.js';

// DoH numeric type → symbolic name (used to render answers).
const TYPE_NUM_TO_NAME: Record<number, string> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  12: 'PTR',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  257: 'CAA',
};

const RCODE_NAMES: Record<number, string> = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
};

interface DigOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type ProxiedFetch = ReturnType<typeof createProxiedFetch>;

function digHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: dig <name> [type] [@server] [+opts] [--json]\n' +
      '       dig -x <address> [@server] [+opts] [--json]\n' +
      '       dig -v | --version\n' +
      '\n' +
      'Resolve DNS records via DNS-over-HTTPS.\n' +
      '\n' +
      'Supported types: ' +
      SUPPORTED_TYPES.join(', ') +
      ' (default: A).\n' +
      '\n' +
      'Flags:\n' +
      '  @server       use a supported Cloudflare, Google, or Quad9 resolver\n' +
      '  -x <address>  reverse lookup (PTR) for an IPv4 or IPv6 address\n' +
      '  -v, --version show version information\n' +
      '  +short        one answer value per line, no headers\n' +
      '  +opts         other dig +options are accepted as no-ops\n' +
      '  --json        resolver response as pretty-printed JSON\n' +
      '  -h, --help    show this help\n',
    stderr: '',
    exitCode: 0,
  };
}

function renderType(type: number): string {
  return TYPE_NUM_TO_NAME[type] ?? `TYPE${type}`;
}

function renderAnswers(payload: DnsResponse, query: DigQueryArgs): DigOutput {
  const { fallbackNote, json, name, short } = query;
  if (typeof payload.Status === 'number' && payload.Status !== 0) {
    const rcode = RCODE_NAMES[payload.Status] ?? String(payload.Status);
    return { stdout: '', stderr: `${fallbackNote}dig: ${name}: ${rcode}\n`, exitCode: 1 };
  }
  if (json) {
    return {
      stdout: `${JSON.stringify(payload, null, 2)}\n`,
      stderr: fallbackNote,
      exitCode: 0,
    };
  }

  const answers = payload.Answer ?? [];
  if (answers.length === 0) {
    const stdout = short ? '' : ';; no records found\n';
    return { stdout, stderr: fallbackNote, exitCode: 0 };
  }
  if (short) {
    return {
      stdout: `${answers.map((answer) => answer.data).join('\n')}\n`,
      stderr: fallbackNote,
      exitCode: 0,
    };
  }
  const lines = answers
    .map(
      (answer) =>
        `${answer.name}\t${answer.TTL ?? 0}\tIN\t${renderType(answer.type)}\t${answer.data}`
    )
    .join('\n');
  return { stdout: `${lines}\n`, stderr: fallbackNote, exitCode: 0 };
}

async function runDig(args: string[], proxiedFetch: ProxiedFetch): Promise<DigOutput> {
  const parsedArgs = parseDigArgs(args);
  if (parsedArgs.kind === 'version') {
    return { stdout: `${DIG_VERSION}\n`, stderr: '', exitCode: 0 };
  }
  if (parsedArgs.kind === 'error') {
    return { stdout: '', stderr: parsedArgs.message, exitCode: 1 };
  }

  const { fallbackNote, name, resolverUrl, type } = parsedArgs;
  const usesDnsMessage = resolverUrl === QUAD9_RESOLVER_URL;
  let url: string;
  let response: Awaited<ReturnType<ProxiedFetch>>;
  try {
    url = usesDnsMessage
      ? buildDnsMessageUrl(resolverUrl, name, type)
      : `${resolverUrl}?name=${encodeURIComponent(name)}&type=${type}`;
    response = await proxiedFetch(url, {
      method: 'GET',
      headers: { Accept: usesDnsMessage ? 'application/dns-message' : 'application/dns-json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `${fallbackNote}dig: ${message}\n`, exitCode: 1 };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      stdout: '',
      stderr: `${fallbackNote}dig: lookup failed: ${response.status} ${response.statusText}\n`,
      exitCode: 1,
    };
  }

  try {
    const payload = usesDnsMessage
      ? parseDnsMessage(response.body, name, type)
      : (JSON.parse(new TextDecoder('utf-8').decode(response.body)) as DnsResponse);
    return renderAnswers(payload, parsedArgs);
  } catch {
    return {
      stdout: '',
      stderr: `${fallbackNote}dig: invalid response from resolver\n`,
      exitCode: 1,
    };
  }
}

export function createDigCommand(): Command {
  // Route through the shared proxied fetch so the request bypasses CORS in
  // CLI / kernel-worker mode and benefits from the secrets pipeline. Built
  // once per command so the SecureFetch closure is reused across invocations
  // — same pattern as `man-command.ts`.
  const proxiedFetch = createProxiedFetch();

  return defineCommand('dig', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return digHelp();
    }
    return runDig(args, proxiedFetch);
  });
}
