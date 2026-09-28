/**
 * An HTTP/1.1 client for the realm proxy's tests: it talks over a kernel
 * socket, as a program's syscalls would, and reads responses with the
 * proxy's own framing code (chunked bodies are chunked either way).
 */
import {
  HttpError,
  Incoming,
  latin1,
  readBody,
} from '../../../../src/kernel/wasm-realm/net/http1.js';
import type {
  HeaderList,
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
  RealmTransportTraits,
} from '../../../../src/kernel/wasm-realm/net/transport.js';
import type { KernelSocket, LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';

export const enc = (s: string) => new TextEncoder().encode(s);
export const text = (b: Uint8Array) => new TextDecoder().decode(b);

export interface Parsed {
  status: number;
  reason: string;
  headers: HeaderList;
  body: string;
  header(name: string): string | undefined;
}

export class Client {
  readonly incoming: Incoming;

  constructor(readonly conn: KernelSocket) {
    this.incoming = new Incoming({ read: (max, signal) => conn.read(max, signal) });
  }

  static open(net: LoopbackNet, port = 3128): Client {
    return new Client(net.connect({ family: 'inet', host: '127.0.0.1', port }));
  }

  async send(request: string | Uint8Array): Promise<void> {
    await this.conn.write(typeof request === 'string' ? enc(request) : request);
  }

  /** The next response; `head`: a response to HEAD (no body whatever it says). */
  async response(opts: { head?: boolean } = {}): Promise<Parsed> {
    const head = await this.incoming.head(1 << 20);
    if (!head) throw new Error('connection closed before a response');
    const lines = latin1(head).split('\r\n');
    const status = /^HTTP\/1\.1 (\d{3}) ?(.*)$/.exec(lines.shift() ?? '');
    if (!status) throw new Error(`bad status line in ${latin1(head)}`);
    const headers: Array<readonly [string, string]> = lines
      .filter((l) => l !== '')
      .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()] as const);
    const get = (name: string) =>
      headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
    const code = Number(status[1]);
    let body = '';
    if (!opts.head && code >= 200 && code !== 204 && code !== 304) {
      if (get('transfer-encoding') === 'chunked') {
        body = text(
          (await readBody(this.incoming, { kind: 'chunked' }, 1 << 30)) ?? new Uint8Array()
        );
      } else if (get('content-length') !== undefined) {
        body = text(await this.incoming.exactly(Number(get('content-length'))));
      } else {
        body = await this.rest();
      }
    }
    return { status: code, reason: status[2], headers, body, header: get };
  }

  /** Everything until the proxy closes the connection. */
  async rest(): Promise<string> {
    let out = '';
    for (;;) {
      try {
        out += text(await this.incoming.exactly(1));
      } catch (e) {
        if (e instanceof HttpError) return out;
        throw e;
      }
    }
  }

  close(): void {
    this.conn.close();
  }
}

/** A response a scripted transport gives. */
export function reply(
  status: number,
  headers: HeaderList,
  ...chunks: Array<string | Uint8Array>
): RealmTransportResponse {
  let cancelled = false;
  const response: RealmTransportResponse & { cancelled(): boolean } = {
    status,
    statusText: '',
    headers,
    body: (async function* () {
      for (const c of chunks) yield typeof c === 'string' ? enc(c) : c;
    })(),
    cancel: async () => {
      cancelled = true;
    },
    cancelled: () => cancelled,
  };
  return response;
}

export interface Scripted {
  transport: RealmTransport;
  seen: RealmTransportRequest[];
}

/** A transport that answers with `handler` and records every request. */
export function scripted(
  handler: (req: RealmTransportRequest) => RealmTransportResponse | Promise<RealmTransportResponse>,
  traits: Partial<RealmTransportTraits> = {}
): Scripted {
  const seen: RealmTransportRequest[] = [];
  return {
    seen,
    transport: {
      traits: { manualRedirects: true, encodedBodies: false, maxRequestBody: 1024, ...traits },
      async fetch(req) {
        seen.push(req);
        return handler(req);
      },
    },
  };
}

/** Resolves on the next macrotask: lets the proxy's pending work run. */
export const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
