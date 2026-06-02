import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createProxiedFetch } from '../proxied-fetch.js';

const RESOLVER_URL = 'https://cloudflare-dns.com/dns-query';

const SUPPORTED_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'SRV', 'PTR', 'CAA'];

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

interface DohAnswer {
  name: string;
  type: number;
  TTL?: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

function digHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: dig <name> [type] [+short] [--json]\n' +
      '\n' +
      'Resolve DNS records via Cloudflare DNS-over-HTTPS.\n' +
      '\n' +
      'Supported types: ' +
      SUPPORTED_TYPES.join(', ') +
      ' (default: A).\n' +
      '\n' +
      'Flags:\n' +
      '  +short    one answer value per line, no headers\n' +
      '  --json    raw resolver JSON (pretty-printed)\n' +
      '  -h, --help  show this help\n',
    stderr: '',
    exitCode: 0,
  };
}

function renderType(type: number): string {
  return TYPE_NUM_TO_NAME[type] ?? `TYPE${type}`;
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

    let short = false;
    let json = false;
    const positional: string[] = [];
    for (const arg of args) {
      if (arg === '+short') {
        short = true;
      } else if (arg === '--json') {
        json = true;
      } else if (arg.startsWith('--')) {
        return { stdout: '', stderr: `dig: unknown option: ${arg}\n`, exitCode: 1 };
      } else if (arg.startsWith('+')) {
        return { stdout: '', stderr: `dig: unknown option: ${arg}\n`, exitCode: 1 };
      } else {
        positional.push(arg);
      }
    }

    if (short && json) {
      return {
        stdout: '',
        stderr: 'dig: +short and --json are mutually exclusive\n',
        exitCode: 1,
      };
    }

    const name = positional[0]?.trim();
    if (!name) {
      return {
        stdout: '',
        stderr: 'dig: missing domain name\nusage: dig <name> [type] [+short] [--json]\n',
        exitCode: 1,
      };
    }

    const typeArg = positional[1]?.trim().toUpperCase() ?? 'A';
    if (!SUPPORTED_TYPES.includes(typeArg)) {
      return {
        stdout: '',
        stderr: `dig: unsupported record type: ${typeArg}\n`,
        exitCode: 1,
      };
    }

    const url = `${RESOLVER_URL}?name=${encodeURIComponent(name)}&type=${typeArg}`;

    let response: Awaited<ReturnType<typeof proxiedFetch>>;
    try {
      response = await proxiedFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/dns-json' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `dig: ${message}\n`, exitCode: 1 };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        stdout: '',
        stderr: `dig: lookup failed: ${response.status} ${response.statusText}\n`,
        exitCode: 1,
      };
    }

    const text = new TextDecoder('utf-8').decode(response.body);
    let payload: DohResponse;
    try {
      payload = JSON.parse(text) as DohResponse;
    } catch {
      return {
        stdout: '',
        stderr: 'dig: invalid response from resolver\n',
        exitCode: 1,
      };
    }

    if (typeof payload.Status === 'number' && payload.Status !== 0) {
      const rcode = RCODE_NAMES[payload.Status] ?? String(payload.Status);
      return { stdout: '', stderr: `dig: ${name}: ${rcode}\n`, exitCode: 1 };
    }

    if (json) {
      return {
        stdout: `${JSON.stringify(payload, null, 2)}\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    const answers = payload.Answer ?? [];

    if (answers.length === 0) {
      if (short) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: ';; no records found\n', stderr: '', exitCode: 0 };
    }

    if (short) {
      const lines = answers.map((a) => a.data).join('\n');
      return { stdout: `${lines}\n`, stderr: '', exitCode: 0 };
    }

    const lines = answers
      .map((a) => `${a.name}\t${a.TTL ?? 0}\tIN\t${renderType(a.type)}\t${a.data}`)
      .join('\n');

    return { stdout: `${lines}\n`, stderr: '', exitCode: 0 };
  });
}
