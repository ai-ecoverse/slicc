export interface ParsedWebsocatArgs {
  url?: string;
  text: boolean;
  binary: boolean;
  oneMessage: boolean;
  noClose: boolean;
  exitOnEof: boolean;
  unidirectional: boolean;
  unidirectionalReverse: boolean;
  insecure: boolean;
  quiet: boolean;
  verbose: number;
  nullTerminated: boolean;
  base64: boolean;
  jsonrpc: boolean;
  jsonrpcOmit: boolean;
  closeStatus?: number;
  closeReason?: string;
  bufferSize: number;
  maxMessages?: number;
  protocol?: string;
  pingInterval?: number;
  connTimeoutMs: number;
  customHeaders: string[];
  showHelp: boolean;
  error?: string;
}

export function defaultParsedWebsocatArgs(): ParsedWebsocatArgs {
  return {
    text: true,
    binary: false,
    oneMessage: false,
    noClose: false,
    exitOnEof: false,
    unidirectional: false,
    unidirectionalReverse: false,
    insecure: false,
    quiet: false,
    verbose: 0,
    nullTerminated: false,
    base64: false,
    jsonrpc: false,
    jsonrpcOmit: false,
    bufferSize: 65536,
    connTimeoutMs: 30000,
    customHeaders: [],
    showHelp: false,
  };
}

export function websocatHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: websocat [FLAGS] [OPTIONS] <ws://URL | wss://URL>

Minimal websocat client. Sends stdin lines as WebSocket messages and prints
received messages to stdout. Server mode and advanced specifiers (exec:, tcp:,
broadcast:, ws-l:, etc.) are NOT supported — slicc's websocat is client-only.

FLAGS:
  -t, --text                 Send stdin as text messages (default)
  -b, --binary               Send stdin as binary messages
  -1, --one-message          Send and/or receive exactly one message, then exit
  -n, --no-close             Do not send a Close frame on stdin EOF
  -E, --exit-on-eof          Exit once peer closes its half
  -u, --unidirectional       Only send (do not print received messages)
  -U, --unidirectional-rev   Only receive (do not send anything from stdin)
  -k, --insecure             No-op in browsers (cert validation is fixed)
  -q                         Suppress diagnostic messages
  -v                         Verbose (repeat for more)
  -0, --null-terminated      Split stdin / output on \\0 instead of \\n
      --base64               Encode binary messages as base64 on output
      --jsonrpc              Wrap stdin lines as JSON-RPC 2.0 method calls
      --jsonrpc-omit-jsonrpc Omit the "jsonrpc":"2.0" field (CDP-style)
  -h, --help                 Show this help

OPTIONS:
      --close-status-code N  Send Close with status code N (default 1000)
      --close-reason TEXT    Close reason string (requires --close-status-code)
  -B, --buffer-size N        Max inbound message size in bytes (default 65536)
      --max-messages N       Exit after N inbound messages
      --protocol NAME        WebSocket subprotocol (Sec-WebSocket-Protocol)
      --ping-interval SEC    Accepted for parity; browsers expose no ping API
      --conn-timeout SEC     Abort connect after SEC seconds (default 30)
  -H, --header "K: V"        Accepted for parity; browsers reject arbitrary
                             headers — only --protocol is honored

EXAMPLES:
  # Echo round-trip
  echo hello | websocat -1 wss://ws.vi-server.org/mirror

  # Send a CDP command to a Chrome target
  echo 'Page.navigate {"url":"https://example.com"}' \\
    | websocat -1 --jsonrpc --jsonrpc-omit-jsonrpc \\
        ws://127.0.0.1:9222/devtools/page/<id>
`,
    stderr: '',
    exitCode: 0,
  };
}

const UNSUPPORTED_FLAGS = new Set([
  '-s',
  '--server-mode',
  '--oneshot',
  '--socks5',
  '--basic-auth',
  '--basic-auth-file',
  '--header-to-env',
  '--server-header',
  '--exec',
  '--ws-c-uri',
  '--restrict-uri',
  '--unlink',
  '--strict',
  '-S',
]);

type ParseStep = { nextIndex: number } | { stop: true };

function consumeValue(
  args: string[],
  i: number,
  flag: string,
  out: ParsedWebsocatArgs
): { value: string; next: number } | null {
  const eq = args[i].indexOf('=');
  if (eq !== -1 && args[i].startsWith(flag)) {
    return { value: args[i].slice(eq + 1), next: i };
  }
  const next = args[i + 1];
  if (next === undefined) {
    out.error = `websocat: missing value for ${flag}\n`;
    return null;
  }
  return { value: next, next: i + 1 };
}

function parsePositiveInt(
  out: ParsedWebsocatArgs,
  raw: string,
  flagLabel: string,
  expects = 'positive integer'
): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    out.error = `websocat: ${flagLabel} expects ${expects}\n`;
    return null;
  }
  return n;
}

function parseCloseStatus(out: ParsedWebsocatArgs, raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000 || n > 4999) {
    out.error = `websocat: --close-status-code expects 1000..4999, got '${raw}'\n`;
    return null;
  }
  return n;
}

function applyBooleanFlags(out: ParsedWebsocatArgs, token: string): boolean {
  const handlers: Record<string, () => void> = {
    '-t': () => {
      out.text = true;
      out.binary = false;
    },
    '--text': () => {
      out.text = true;
      out.binary = false;
    },
    '-b': () => {
      out.binary = true;
      out.text = false;
    },
    '--binary': () => {
      out.binary = true;
      out.text = false;
    },
    '-1n': () => {
      out.oneMessage = true;
      out.noClose = true;
    },
    '-n1': () => {
      out.oneMessage = true;
      out.noClose = true;
    },
    '-1': () => {
      out.oneMessage = true;
    },
    '--one-message': () => {
      out.oneMessage = true;
    },
    '-n': () => {
      out.noClose = true;
    },
    '--no-close': () => {
      out.noClose = true;
    },
    '-E': () => {
      out.exitOnEof = true;
    },
    '--exit-on-eof': () => {
      out.exitOnEof = true;
    },
    '-u': () => {
      out.unidirectional = true;
    },
    '--unidirectional': () => {
      out.unidirectional = true;
    },
    '-U': () => {
      out.unidirectionalReverse = true;
    },
    '--unidirectional-reverse': () => {
      out.unidirectionalReverse = true;
    },
    '-k': () => {
      out.insecure = true;
    },
    '--insecure': () => {
      out.insecure = true;
    },
    '-q': () => {
      out.quiet = true;
    },
    '-0': () => {
      out.nullTerminated = true;
    },
    '--null-terminated': () => {
      out.nullTerminated = true;
    },
    '--base64': () => {
      out.base64 = true;
    },
    '--jsonrpc': () => {
      out.jsonrpc = true;
    },
    '--jsonrpc-omit-jsonrpc': () => {
      out.jsonrpcOmit = true;
      out.jsonrpc = true;
    },
  };
  const handler = handlers[token];
  if (!handler) return false;
  handler();
  return true;
}

function applyVerboseFlag(out: ParsedWebsocatArgs, token: string): boolean {
  if (token === '-v') {
    out.verbose += 1;
    return true;
  }
  if (token === '-vv') {
    out.verbose += 2;
    return true;
  }
  return false;
}

function assignStringOption(
  out: ParsedWebsocatArgs,
  args: string[],
  i: number,
  flag: string,
  assign: (value: string) => void
): ParseStep | null {
  const r = consumeValue(args, i, flag, out);
  if (!r) return { stop: true };
  assign(r.value);
  return { nextIndex: r.next };
}

function assignPositiveIntOption(
  out: ParsedWebsocatArgs,
  args: string[],
  i: number,
  flag: string,
  label: string,
  assign: (value: number) => void,
  expects?: string
): ParseStep | null {
  const r = consumeValue(args, i, flag, out);
  if (!r) return { stop: true };
  const n = parsePositiveInt(out, r.value, label, expects);
  if (n === null) return { stop: true };
  assign(n);
  return { nextIndex: r.next };
}

function tokenMatches(token: string, names: readonly string[]): boolean {
  return names.some((name) => token === name || token.startsWith(`${name}=`));
}

type ValueFlagHandler = (
  out: ParsedWebsocatArgs,
  args: string[],
  i: number,
  token: string
) => ParseStep | null;

const VALUE_FLAG_HANDLERS: ValueFlagHandler[] = [
  (out, args, i, token) => {
    if (!tokenMatches(token, ['--close-status-code'])) return null;
    const r = consumeValue(args, i, '--close-status-code', out);
    if (!r) return { stop: true };
    const n = parseCloseStatus(out, r.value);
    if (n === null) return { stop: true };
    out.closeStatus = n;
    return { nextIndex: r.next };
  },
  (out, args, i, token) => {
    if (!tokenMatches(token, ['--close-reason'])) return null;
    return assignStringOption(out, args, i, '--close-reason', (value) => {
      out.closeReason = value;
    });
  },
  (out, args, i, token) => {
    if (!tokenMatches(token, ['-B', '--buffer-size'])) return null;
    const flag = token === '-B' ? '-B' : '--buffer-size';
    return assignPositiveIntOption(out, args, i, flag, '--buffer-size', (n) => {
      out.bufferSize = n;
    });
  },
  (out, args, i, token) => {
    if (!tokenMatches(token, ['--max-messages'])) return null;
    return assignPositiveIntOption(out, args, i, '--max-messages', '--max-messages', (n) => {
      out.maxMessages = n;
    });
  },
  (out, args, i, token) => {
    if (!tokenMatches(token, ['--protocol'])) return null;
    return assignStringOption(out, args, i, '--protocol', (value) => {
      out.protocol = value;
    });
  },
  (out, args, i, token) => {
    if (!tokenMatches(token, ['--ping-interval'])) return null;
    const r = consumeValue(args, i, '--ping-interval', out);
    if (!r) return { stop: true };
    out.pingInterval = Number(r.value);
    return { nextIndex: r.next };
  },
  (out, args, i, token) => {
    if (!tokenMatches(token, ['--conn-timeout'])) return null;
    const step = assignPositiveIntOption(
      out,
      args,
      i,
      '--conn-timeout',
      '--conn-timeout',
      (n) => {
        out.connTimeoutMs = Math.round(n * 1000);
      },
      'positive seconds'
    );
    return step;
  },
  (out, args, i, token) => {
    if (!tokenMatches(token, ['-H', '--header'])) return null;
    const flag = token === '-H' ? '-H' : '--header';
    return assignStringOption(out, args, i, flag, (value) => {
      out.customHeaders.push(value);
    });
  },
];

function applyValueFlag(
  out: ParsedWebsocatArgs,
  args: string[],
  i: number,
  token: string
): ParseStep | null {
  for (const handler of VALUE_FLAG_HANDLERS) {
    const step = handler(out, args, i, token);
    if (step) return step;
  }
  return null;
}

function validateCloseReason(out: ParsedWebsocatArgs): void {
  if (out.closeReason !== undefined && out.closeStatus === undefined) {
    out.error =
      'websocat: --close-reason requires --close-status-code (the WebSocket close frame cannot carry a reason without a status code)\n';
  }
}

export function parseWebsocatArgs(args: string[]): ParsedWebsocatArgs {
  const out = defaultParsedWebsocatArgs();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === '-h' || token === '--help') {
      out.showHelp = true;
      return out;
    }

    if (UNSUPPORTED_FLAGS.has(token) || UNSUPPORTED_FLAGS.has(token.split('=')[0])) {
      out.error = `websocat: flag '${token}' is not supported in slicc's minimal client\n`;
      return out;
    }

    if (applyBooleanFlags(out, token)) continue;
    if (applyVerboseFlag(out, token)) continue;

    const valueStep = applyValueFlag(out, args, i, token);
    if (valueStep) {
      if ('stop' in valueStep) return out;
      i = valueStep.nextIndex;
      continue;
    }

    if (token.startsWith('-')) {
      out.error = `websocat: unknown flag '${token}'\n`;
      return out;
    }

    if (out.url) {
      out.error = `websocat: extra positional argument '${token}' — advanced mode is not supported\n`;
      return out;
    }
    out.url = token;
  }

  validateCloseReason(out);
  return out;
}
