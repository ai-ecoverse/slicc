import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

interface ParsedArgs {
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

function websocatHelp(): { stdout: string; stderr: string; exitCode: number } {
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

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
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

  const consumeValue = (i: number, flag: string): { value: string; next: number } | null => {
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
  };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];

    if (a === '-h' || a === '--help') {
      out.showHelp = true;
      return out;
    }

    if (UNSUPPORTED_FLAGS.has(a) || UNSUPPORTED_FLAGS.has(a.split('=')[0])) {
      out.error = `websocat: flag '${a}' is not supported in slicc's minimal client\n`;
      return out;
    }

    if (a === '-t' || a === '--text') {
      out.text = true;
      out.binary = false;
      continue;
    }
    if (a === '-b' || a === '--binary') {
      out.binary = true;
      out.text = false;
      continue;
    }
    if (a === '-1' || a === '--one-message') {
      out.oneMessage = true;
      continue;
    }
    if (a === '-n' || a === '--no-close') {
      out.noClose = true;
      continue;
    }
    if (a === '-E' || a === '--exit-on-eof') {
      out.exitOnEof = true;
      continue;
    }
    if (a === '-u' || a === '--unidirectional') {
      out.unidirectional = true;
      continue;
    }
    if (a === '-U' || a === '--unidirectional-reverse') {
      out.unidirectionalReverse = true;
      continue;
    }
    if (a === '-k' || a === '--insecure') {
      out.insecure = true;
      continue;
    }
    if (a === '-q') {
      out.quiet = true;
      continue;
    }
    if (a === '-v') {
      out.verbose += 1;
      continue;
    }
    if (a === '-vv') {
      out.verbose += 2;
      continue;
    }
    if (a === '-0' || a === '--null-terminated') {
      out.nullTerminated = true;
      continue;
    }
    if (a === '--base64') {
      out.base64 = true;
      continue;
    }
    if (a === '--jsonrpc') {
      out.jsonrpc = true;
      continue;
    }
    if (a === '--jsonrpc-omit-jsonrpc') {
      out.jsonrpcOmit = true;
      out.jsonrpc = true;
      continue;
    }
    if (a === '-1' || a.startsWith('-1')) {
      out.oneMessage = true;
      continue;
    }

    if (a === '-n1' || a === '-1n') {
      out.noClose = true;
      out.oneMessage = true;
      continue;
    }

    if (a === '--close-status-code' || a.startsWith('--close-status-code=')) {
      const r = consumeValue(i, '--close-status-code');
      if (!r) return out;
      const n = Number(r.value);
      if (!Number.isFinite(n) || n < 1000 || n > 4999) {
        out.error = `websocat: --close-status-code expects 1000..4999, got '${r.value}'\n`;
        return out;
      }
      out.closeStatus = n;
      i = r.next;
      continue;
    }
    if (a === '--close-reason' || a.startsWith('--close-reason=')) {
      const r = consumeValue(i, '--close-reason');
      if (!r) return out;
      out.closeReason = r.value;
      i = r.next;
      continue;
    }
    if (a === '-B' || a === '--buffer-size' || a.startsWith('--buffer-size=')) {
      const r = consumeValue(i, a === '-B' ? '-B' : '--buffer-size');
      if (!r) return out;
      const n = Number(r.value);
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `websocat: --buffer-size expects positive integer\n`;
        return out;
      }
      out.bufferSize = n;
      i = r.next;
      continue;
    }
    if (a === '--max-messages' || a.startsWith('--max-messages=')) {
      const r = consumeValue(i, '--max-messages');
      if (!r) return out;
      const n = Number(r.value);
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `websocat: --max-messages expects positive integer\n`;
        return out;
      }
      out.maxMessages = n;
      i = r.next;
      continue;
    }
    if (a === '--protocol' || a.startsWith('--protocol=')) {
      const r = consumeValue(i, '--protocol');
      if (!r) return out;
      out.protocol = r.value;
      i = r.next;
      continue;
    }
    if (a === '--ping-interval' || a.startsWith('--ping-interval=')) {
      const r = consumeValue(i, '--ping-interval');
      if (!r) return out;
      out.pingInterval = Number(r.value);
      i = r.next;
      continue;
    }
    if (a === '--conn-timeout' || a.startsWith('--conn-timeout=')) {
      const r = consumeValue(i, '--conn-timeout');
      if (!r) return out;
      const n = Number(r.value);
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `websocat: --conn-timeout expects positive seconds\n`;
        return out;
      }
      out.connTimeoutMs = Math.round(n * 1000);
      i = r.next;
      continue;
    }
    if (a === '-H' || a === '--header' || a.startsWith('--header=')) {
      const r = consumeValue(i, a === '-H' ? '-H' : '--header');
      if (!r) return out;
      out.customHeaders.push(r.value);
      i = r.next;
      continue;
    }

    if (a.startsWith('-')) {
      out.error = `websocat: unknown flag '${a}'\n`;
      return out;
    }

    if (out.url) {
      out.error = `websocat: extra positional argument '${a}' — advanced mode is not supported\n`;
      return out;
    }
    out.url = a;
  }

  return out;
}

function splitStdin(stdin: string, nullTerm: boolean): string[] {
  if (!stdin) return [];
  const sep = nullTerm ? '\0' : '\n';
  const parts = stdin.split(sep);
  // Drop the trailing empty fragment when input ended with the separator.
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function buildJsonRpc(line: string, id: number, omit: boolean): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  const spaceIdx = trimmed.search(/\s/);
  const method = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  let params: unknown = [];
  if (rest) {
    try {
      params = JSON.parse(rest);
    } catch {
      params = [rest];
    }
  }
  const payload: Record<string, unknown> = { id, method, params };
  if (!omit) payload.jsonrpc = '2.0';
  return JSON.stringify(payload);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  // btoa exists in browsers + Node 16+
  return btoa(bin);
}

function bytesToTextSafe(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return bytesToBase64(bytes);
  }
}

interface WebsocatRunDeps {
  WebSocketCtor?: typeof WebSocket;
}

export async function runWebsocat(
  args: string[],
  ctx: { stdin: string },
  deps: WebsocatRunDeps = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const parsed = parseArgs(args);
  if (parsed.showHelp) return websocatHelp();
  if (parsed.error) return { stdout: '', stderr: parsed.error, exitCode: 2 };
  if (!parsed.url) {
    return {
      stdout: '',
      stderr: 'websocat: missing ws:// or wss:// URL (use --help for usage)\n',
      exitCode: 2,
    };
  }
  if (!/^wss?:\/\//i.test(parsed.url)) {
    return {
      stdout: '',
      stderr: `websocat: URL must start with ws:// or wss://, got '${parsed.url}'\n`,
      exitCode: 2,
    };
  }

  const WS = deps.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
  if (!WS) {
    return {
      stdout: '',
      stderr: 'websocat: no WebSocket implementation available in this runtime\n',
      exitCode: 1,
    };
  }

  const diagnostics: string[] = [];
  const note = (msg: string) => {
    if (!parsed.quiet) diagnostics.push(`websocat: ${msg}`);
  };
  if (parsed.verbose >= 1) {
    if (parsed.customHeaders.length > 0) {
      note(
        '-H/--header is accepted for parity but browsers do not allow setting WebSocket request headers; only --protocol is honored'
      );
    }
    if (parsed.pingInterval !== undefined) {
      note('--ping-interval has no effect in browsers (no ping API exposed)');
    }
    if (parsed.insecure) {
      note('-k/--insecure has no effect in browsers');
    }
  }

  const outLines: string[] = [];
  const outSep = parsed.nullTerminated ? '\0' : '\n';

  let ws: WebSocket;
  try {
    ws = parsed.protocol ? new WS(parsed.url, parsed.protocol) : new WS(parsed.url);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `websocat: connect failed: ${m}\n`, exitCode: 1 };
  }
  ws.binaryType = 'arraybuffer';

  let received = 0;
  // Cap the in-memory output buffer to bound RSS for long-running sessions.
  // Inbound messages beyond this drop with a single diagnostic warning so the
  // command can't OOM the host page on a chatty server when neither -1 nor
  // --max-messages is set.
  const MAX_OUT_LINES = 10000;
  let droppedForOverflow = 0;
  let opened = false;
  let openedResolve!: () => void;
  let openedReject!: (e: Error) => void;
  const openedPromise = new Promise<void>((res, rej) => {
    openedResolve = res;
    openedReject = rej;
  });

  let doneResolve!: (code: number) => void;
  let doneSettled = false;
  const done = new Promise<number>((res) => {
    doneResolve = (code: number) => {
      if (doneSettled) return;
      doneSettled = true;
      res(code);
    };
  });

  let exitCode = 0;
  let timedOut = false;
  const connTimer = setTimeout(() => {
    timedOut = true;
    try {
      ws.close();
    } catch {
      /* noop */
    }
    if (!opened) openedReject(new Error('connect timeout'));
  }, parsed.connTimeoutMs);

  ws.onopen = () => {
    clearTimeout(connTimer);
    opened = true;
    openedResolve();
  };

  let finishing = false;
  ws.onmessage = (ev: MessageEvent) => {
    if (parsed.unidirectional) return; // -u suppresses receive output
    if (finishing) return;
    let bytes: Uint8Array;
    let isBinary = false;
    if (typeof ev.data === 'string') {
      bytes = new TextEncoder().encode(ev.data);
    } else if (ev.data instanceof ArrayBuffer) {
      bytes = new Uint8Array(ev.data);
      isBinary = true;
    } else if (ArrayBuffer.isView(ev.data)) {
      bytes = new Uint8Array(
        (ev.data as ArrayBufferView).buffer,
        (ev.data as ArrayBufferView).byteOffset,
        (ev.data as ArrayBufferView).byteLength
      );
      isBinary = true;
    } else {
      bytes = new TextEncoder().encode(String(ev.data));
    }
    if (bytes.length > parsed.bufferSize) {
      note(
        `inbound message of ${bytes.length} bytes exceeds --buffer-size ${parsed.bufferSize}; truncating`
      );
      bytes = bytes.slice(0, parsed.bufferSize);
    }
    const line = isBinary && parsed.base64 ? bytesToBase64(bytes) : bytesToTextSafe(bytes);
    if (outLines.length < MAX_OUT_LINES) {
      outLines.push(line);
    } else if (droppedForOverflow === 0) {
      note(
        `output buffer reached ${MAX_OUT_LINES} messages; dropping further inbound messages — use -1, --max-messages, or pipe to a file with a different tool for long-running streams`
      );
      droppedForOverflow += 1;
    } else {
      droppedForOverflow += 1;
    }
    received += 1;

    if (parsed.maxMessages !== undefined && received >= parsed.maxMessages) {
      finishing = true;
      closeAndFinish(parsed.closeStatus ?? 1000, parsed.closeReason);
      return;
    }
    if (parsed.oneMessage) {
      finishing = true;
      closeAndFinish(parsed.closeStatus ?? 1000, parsed.closeReason);
    }
  };

  ws.onerror = () => {
    // Browsers do not expose a useful error payload here; surface generic.
    if (timedOut) return;
    note('websocket error');
    exitCode = 1;
    // If the error fires before onopen, no future open event is coming —
    // reject the opened promise so the outer await doesn't hang. The follow-up
    // onclose still drives the final exit code.
    if (!opened) openedReject(new Error('connect failed'));
  };

  ws.onclose = (ev: CloseEvent) => {
    clearTimeout(connTimer);
    if (timedOut) {
      doneResolve(124);
      return;
    }
    if (parsed.verbose >= 1) {
      note(`closed code=${ev.code} reason=${JSON.stringify(ev.reason || '')}`);
    }
    if (exitCode === 0 && ev.code !== 1000 && ev.code !== 1005 && ev.code !== 1001) {
      // Non-normal close → non-zero exit
      exitCode = 1;
    }
    // Same defensive rejection as in onerror: if the socket closes before
    // open, the outer `await opened` must unblock.
    if (!opened) openedReject(new Error(`connect closed (code ${ev.code})`));
    doneResolve(exitCode);
  };

  function closeAndFinish(code: number, reason?: string) {
    try {
      if (reason !== undefined) ws.close(code, reason);
      else ws.close(code);
    } catch {
      /* noop */
    }
  }

  try {
    await openedPromise;
  } catch (err) {
    clearTimeout(connTimer);
    const m = err instanceof Error ? err.message : String(err);
    return {
      stdout: outLines.join(outSep) + (outLines.length ? outSep : ''),
      stderr: diagnostics.concat([`websocat: ${m}`]).join('\n') + (diagnostics.length ? '\n' : ''),
      exitCode: m === 'connect timeout' ? 124 : 1,
    };
  }

  // Send stdin lines (unless -U).
  if (!parsed.unidirectionalReverse) {
    const lines = splitStdin(ctx.stdin, parsed.nullTerminated);
    let id = 1;
    let sent = 0;
    const toSend = parsed.oneMessage ? lines.slice(0, 1) : lines;
    for (const raw of toSend) {
      let payload: string | ArrayBuffer = raw;
      if (parsed.jsonrpc) {
        payload = buildJsonRpc(raw, id, parsed.jsonrpcOmit);
        id += 1;
      }
      if (parsed.binary) {
        ws.send(new TextEncoder().encode(payload as string).buffer as ArrayBuffer);
      } else {
        ws.send(payload as string);
      }
      sent += 1;
    }

    if (!parsed.oneMessage && !parsed.noClose && (parsed.exitOnEof || sent === 0)) {
      // EOF on stdin + close requested → send close after a tick to drain
      setTimeout(() => {
        closeAndFinish(parsed.closeStatus ?? 1000, parsed.closeReason);
      }, 0);
    }
  } else if (!parsed.noClose && parsed.exitOnEof && !parsed.oneMessage) {
    setTimeout(() => {
      closeAndFinish(parsed.closeStatus ?? 1000, parsed.closeReason);
    }, 0);
  }

  const code = await done;
  if (droppedForOverflow > 0) {
    note(`dropped ${droppedForOverflow} inbound message(s) due to output buffer cap`);
  }
  const stdout = outLines.length ? outLines.join(outSep) + outSep : '';
  const stderr = diagnostics.length ? diagnostics.join('\n') + '\n' : '';
  return { stdout, stderr, exitCode: code };
}

export function createWebsocatCommand(): Command {
  return defineCommand('websocat', async (args, ctx) => {
    return runWebsocat(args, { stdin: ctx.stdin });
  });
}
