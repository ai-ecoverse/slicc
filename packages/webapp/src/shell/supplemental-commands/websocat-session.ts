import type { ParsedWebsocatArgs } from './websocat-args.js';
import {
  buildJsonRpc,
  bytesToBase64,
  bytesToTextSafe,
  messageDataToBytes,
  splitStdin,
} from './websocat-encoding.js';

export interface WebsocatRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_OUT_LINES = 10000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSettledDeferred<T>(): Deferred<T> & { settle: (value: T) => void } {
  let settled = false;
  const deferred = createDeferred<T>();
  return {
    ...deferred,
    settle: (value: T) => {
      if (settled) return;
      settled = true;
      deferred.resolve(value);
    },
  };
}

function formatOutput(lines: string[], sep: string): string {
  return lines.length ? lines.join(sep) + sep : '';
}

function formatDiagnostics(diagnostics: string[]): string {
  return diagnostics.length ? diagnostics.join('\n') + '\n' : '';
}

function noteDiagnostic(parsed: ParsedWebsocatArgs, diagnostics: string[], msg: string): void {
  if (!parsed.quiet) diagnostics.push(`websocat: ${msg}`);
}

function emitVerboseParityNotes(parsed: ParsedWebsocatArgs, diagnostics: string[]): void {
  if (parsed.verbose < 1) return;
  if (parsed.customHeaders.length > 0) {
    noteDiagnostic(
      parsed,
      diagnostics,
      '-H/--header is accepted for parity but browsers do not allow setting WebSocket request headers; only --protocol is honored'
    );
  }
  if (parsed.pingInterval !== undefined) {
    noteDiagnostic(
      parsed,
      diagnostics,
      '--ping-interval has no effect in browsers (no ping API exposed)'
    );
  }
  if (parsed.insecure) {
    noteDiagnostic(parsed, diagnostics, '-k/--insecure has no effect in browsers');
  }
}

function connectWebSocket(
  Ws: typeof WebSocket,
  parsed: ParsedWebsocatArgs
): { ws: WebSocket } | { error: string } {
  try {
    const ws = parsed.protocol ? new Ws(parsed.url!, parsed.protocol) : new Ws(parsed.url!);
    ws.binaryType = 'arraybuffer';
    return { ws };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { error: `websocat: connect failed: ${m}\n` };
  }
}

interface InboundState {
  outLines: string[];
  droppedForOverflow: number;
  received: number;
  finishing: boolean;
}

function appendInboundLine(
  parsed: ParsedWebsocatArgs,
  diagnostics: string[],
  state: InboundState,
  line: string
): void {
  if (state.outLines.length < MAX_OUT_LINES) {
    state.outLines.push(line);
    return;
  }
  if (state.droppedForOverflow === 0) {
    noteDiagnostic(
      parsed,
      diagnostics,
      `output buffer reached ${MAX_OUT_LINES} messages; dropping further inbound messages — use -1, --max-messages, or pipe to a file with a different tool for long-running streams`
    );
  }
  state.droppedForOverflow += 1;
}

function formatInboundMessage(
  parsed: ParsedWebsocatArgs,
  diagnostics: string[],
  data: unknown
): string {
  let { bytes, isBinary } = messageDataToBytes(data);
  if (bytes.length > parsed.bufferSize) {
    noteDiagnostic(
      parsed,
      diagnostics,
      `inbound message of ${bytes.length} bytes exceeds --buffer-size ${parsed.bufferSize}; truncating`
    );
    bytes = bytes.slice(0, parsed.bufferSize);
  }
  return isBinary && parsed.base64 ? bytesToBase64(bytes) : bytesToTextSafe(bytes);
}

function shouldFinishAfterMessage(parsed: ParsedWebsocatArgs, received: number): boolean {
  if (parsed.maxMessages !== undefined && received >= parsed.maxMessages) return true;
  return parsed.oneMessage;
}

function closeWebSocket(ws: WebSocket, code: number, reason?: string): void {
  try {
    if (reason !== undefined) ws.close(code, reason);
    else ws.close(code);
  } catch {
    /* noop */
  }
}

function scheduleCloseOnEof(parsed: ParsedWebsocatArgs, ws: WebSocket): void {
  setTimeout(() => {
    closeWebSocket(ws, parsed.closeStatus ?? 1000, parsed.closeReason);
  }, 0);
}

function sendStdinMessages(ws: WebSocket, parsed: ParsedWebsocatArgs, stdin: string): number {
  const lines = splitStdin(stdin, parsed.nullTerminated);
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
  return sent;
}

function maybeScheduleStdinClose(ws: WebSocket, parsed: ParsedWebsocatArgs, sent: number): void {
  if (!parsed.oneMessage && !parsed.noClose && (parsed.exitOnEof || sent === 0)) {
    scheduleCloseOnEof(parsed, ws);
  }
}

export async function runWebsocatSession(
  parsed: ParsedWebsocatArgs,
  stdin: string,
  Ws: typeof WebSocket
): Promise<WebsocatRunResult> {
  const diagnostics: string[] = [];
  emitVerboseParityNotes(parsed, diagnostics);

  const outSep = parsed.nullTerminated ? '\0' : '\n';
  const connected = connectWebSocket(Ws, parsed);
  if ('error' in connected) {
    return { stdout: '', stderr: connected.error, exitCode: 1 };
  }
  const { ws } = connected;

  const inbound: InboundState = {
    outLines: [],
    droppedForOverflow: 0,
    received: 0,
    finishing: false,
  };

  let opened = false;
  const openedDeferred = createDeferred<void>();
  const doneDeferred = createSettledDeferred<number>();
  let exitCode = 0;
  let timedOut = false;

  const connTimer = setTimeout(() => {
    timedOut = true;
    closeWebSocket(ws, 1000);
    if (!opened) openedDeferred.reject(new Error('connect timeout'));
  }, parsed.connTimeoutMs);

  const terminate = () => {
    if (parsed.noClose) {
      doneDeferred.settle(exitCode);
      return;
    }
    closeWebSocket(ws, parsed.closeStatus ?? 1000, parsed.closeReason);
  };

  ws.onopen = () => {
    clearTimeout(connTimer);
    opened = true;
    openedDeferred.resolve();
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (inbound.finishing) return;
    if (!parsed.unidirectional) {
      const line = formatInboundMessage(parsed, diagnostics, ev.data);
      appendInboundLine(parsed, diagnostics, inbound, line);
    }
    inbound.received += 1;
    if (shouldFinishAfterMessage(parsed, inbound.received)) {
      inbound.finishing = true;
      terminate();
    }
  };

  ws.onerror = () => {
    if (timedOut) return;
    noteDiagnostic(parsed, diagnostics, 'websocket error');
    exitCode = 1;
    if (!opened) openedDeferred.reject(new Error('connect failed'));
  };

  ws.onclose = (ev: CloseEvent) => {
    clearTimeout(connTimer);
    if (timedOut) {
      doneDeferred.settle(124);
      return;
    }
    if (parsed.verbose >= 1) {
      noteDiagnostic(
        parsed,
        diagnostics,
        `closed code=${ev.code} reason=${JSON.stringify(ev.reason || '')}`
      );
    }
    if (exitCode === 0 && ev.code !== 1000 && ev.code !== 1005 && ev.code !== 1001) {
      exitCode = 1;
    }
    if (!opened) openedDeferred.reject(new Error(`connect closed (code ${ev.code})`));
    doneDeferred.settle(exitCode);
  };

  try {
    await openedDeferred.promise;
  } catch (err) {
    clearTimeout(connTimer);
    const m = err instanceof Error ? err.message : String(err);
    return {
      stdout: formatOutput(inbound.outLines, outSep),
      stderr: formatDiagnostics(diagnostics.concat([`websocat: ${m}`])),
      exitCode: m === 'connect timeout' ? 124 : 1,
    };
  }

  if (!parsed.unidirectionalReverse) {
    const sent = sendStdinMessages(ws, parsed, stdin);
    maybeScheduleStdinClose(ws, parsed, sent);
  } else if (!parsed.noClose && parsed.exitOnEof && !parsed.oneMessage) {
    scheduleCloseOnEof(parsed, ws);
  }

  const code = await doneDeferred.promise;
  if (inbound.droppedForOverflow > 0) {
    noteDiagnostic(
      parsed,
      diagnostics,
      `dropped ${inbound.droppedForOverflow} inbound message(s) due to output buffer cap`
    );
  }
  return {
    stdout: formatOutput(inbound.outLines, outSep),
    stderr: formatDiagnostics(diagnostics),
    exitCode: code,
  };
}
