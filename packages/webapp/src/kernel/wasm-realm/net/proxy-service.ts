/**
 * `proxy-service.ts` — the wasm realm's HTTP proxy (#3571): a TypeScript
 * kernel service listening on an owner's loopback namespace, through which
 * native programs (curl, libcurl, git) reach the outside world over the
 * float's fetch path ({@link RealmTransport}).
 *
 * - An absolute-form request (`GET http://host/path HTTP/1.1`) is forwarded
 *   through the transport; its response is streamed back chunked, so a large
 *   download holds one chunk at a time and a slow client slows the upstream
 *   read (every write waits for room in the socket's pipe).
 * - `CONNECT host:port` hands the connection to a tunnel handler (TLS
 *   termination); without one it is 501.
 * - Connections are kept alive and pipelined requests answered in order.
 *   Nothing is read from a connection while its response is written, so a
 *   client that sends ahead fills its pipe and waits.
 * - Bounds: connections served at once (the rest wait in the listen backlog,
 *   then are refused), request head size, request body size (the transport's
 *   cap), request bytes buffered across connections, and time between reads.
 *
 * The realm's own loopback is never proxied: a request for `localhost` or
 * `127.x` is 403 (it belongs in `no_proxy`), so the host's loopback is not
 * reached by accident through the CLI's fetch route.
 */
import { createLogger } from '../../../base/logger.js';
import { KernelError } from '../fd-table.js';
import type { KernelSocket, LoopbackNet } from '../socket.js';
import {
  type ByteSource,
  chunk,
  fieldTokens,
  fieldValues,
  HttpError,
  Incoming,
  LAST_CHUNK,
  latin1Bytes,
  parseRequestHead,
  REASON,
  type RequestHead,
  readBody,
  requestFraming,
  responseHead,
} from './http1.js';
import type { HeaderList, RealmTransport, RealmTransportResponse } from './transport.js';

const log = createLogger('realm-proxy');

/** The port the realm's proxy listens on in every owner's namespace. */
export const REALM_PROXY_PORT = 3128;

export interface ProxyLimits {
  /** Connections served at once. */
  maxConnections: number;
  /** Largest request head (request line and fields), in bytes. */
  maxHead: number;
  /** Longest wait for the next bytes of a request, in ms (an idle keep-alive connection too). */
  idleMs: number;
  /** Request body bytes buffered across all connections at once. */
  bodyBudget: number;
}

const DEFAULT_LIMITS: ProxyLimits = {
  maxConnections: 64,
  maxHead: 64 * 1024,
  idleMs: 120_000,
  bodyBudget: 128 * 1024 * 1024,
};

/** Where a CONNECT asks to go. */
export interface TunnelTarget {
  host: string;
  port: number;
}

/** Where the proxy writes a response: the client's socket, or a tunnel's TLS layer. */
export interface HttpSink {
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Serve HTTP/1.1 requests read from `source` for `origin` (`https://host`):
 * origin-form requests (or absolute ones for that origin) whose `Host` names
 * it, forwarded as the proxy forwards any other; responses go to `sink`.
 * Resolves when the client is done.
 */
export type ServeHttp = (source: ByteSource, sink: HttpSink, origin: string) => Promise<void>;

/**
 * Serves a CONNECT tunnel once the proxy has answered it with 200: reads the
 * client's bytes (the ones already buffered first, from `incoming`) and
 * writes to `conn`, and may hand the requests inside to `serveHttp`; resolves
 * when the tunnel is done. The proxy then closes the connection.
 */
export type TunnelHandler = (
  conn: KernelSocket,
  incoming: Incoming,
  target: TunnelTarget,
  signal: AbortSignal,
  serveHttp: ServeHttp
) => Promise<void>;

export interface RealmProxyOptions {
  net: LoopbackNet;
  transport: RealmTransport;
  /** Default `127.0.0.1:3128`. */
  host?: string;
  port?: number;
  /** CONNECT handling; absent, CONNECT is 501. */
  tunnel?: TunnelHandler;
  limits?: Partial<ProxyLimits>;
}

/** Hop-by-hop fields (RFC 9110 §7.6.1) and the proxy's own: never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Request fields the transport sets itself. */
const REQUEST_OWN = new Set(['host', 'content-length', 'expect']);

/** A counting semaphore: `acquire(n)` waits until `n` units are free. */
class Budget {
  private waiters: Array<() => void> = [];

  constructor(private free: number) {}

  async acquire(n: number, signal: AbortSignal): Promise<void> {
    while (this.free < n) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const done = (): void => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.push(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    this.free -= n;
  }

  release(n: number): void {
    this.free += n;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

/**
 * A host as the fetch path resolves it: WHATWG host parsing, which turns
 * `2130706433`, `0x7f.1`, `0177.0.0.1` and `127.1` into `127.0.0.1` and
 * writes IPv6 compressed in hex (`[::ffff:127.0.0.1]` is `[::ffff:7f00:1]`).
 * Undefined when it is no host at all.
 */
export function canonicalHost(host: string): string | undefined {
  const bare = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    return new URL(`http://${bare}/`).hostname;
  } catch {
    return undefined;
  }
}

/** 127/8, 0/8 (0.0.0.0 among them) and link-local 169.254/16. */
function localV4(a: number, b: number): boolean {
  return a === 127 || a === 0 || (a === 169 && b === 254);
}

/** An IPv6 address (hex, as `canonicalHost` writes it) as eight 16-bit groups. */
function hextets(address: string): number[] | undefined {
  const [head, tail, extra] = address.split('::');
  if (extra !== undefined) return undefined;
  const part = (text: string | undefined) =>
    text ? text.split(':').map((h) => Number.parseInt(h, 16)) : [];
  const front = part(head);
  const back = part(tail);
  const groups =
    tail === undefined
      ? front
      : [...front, ...new Array(8 - front.length - back.length).fill(0), ...back];
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

/** `::`, `::1`, link-local fe80::/10, and IPv4-mapped / -compatible forms of a local IPv4. */
function localV6(address: string): boolean {
  const g = hextets(address);
  if (!g) return true; // unparseable: refuse rather than guess
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  const zeroPrefix = g.slice(0, 5).every((x) => x === 0);
  if (!zeroPrefix) return false;
  if (g[5] === 0xffff || (g[5] === 0 && g[6] !== 0)) return localV4(g[6] >> 8, g[6] & 0xff);
  // ::, ::1 (and the rest of ::/112, none of it routable)
  return g[5] === 0 && g[6] === 0;
}

/**
 * Whether a host names the realm's own loopback (or the host machine's, which
 * the fetch path would reach instead): `localhost`, `*.localhost`, loopback,
 * unspecified and link-local addresses in any spelling a URL accepts.
 */
export function isLoopbackHost(hostname: string): boolean {
  const canonical = canonicalHost(hostname);
  if (canonical === undefined) return false;
  const host = canonical.replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.startsWith('[')) return localV6(host.slice(1, -1));
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  return v4 ? localV4(Number(v4[1]), Number(v4[2])) : false;
}

/** The fields a header list names in `Connection` plus the hop-by-hop set. */
function dropped(headers: HeaderList): Set<string> {
  return new Set([...HOP_BY_HOP, ...fieldTokens(headers, 'connection')]);
}

/** A request's end-to-end fields, for the transport. */
export function forwardRequestHeaders(headers: HeaderList): HeaderList {
  const drop = dropped(headers);
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !drop.has(lower) && !REQUEST_OWN.has(lower);
  });
}

/**
 * A response's end-to-end fields for the client. The proxy frames the body
 * itself, so `Content-Length` goes (except on a bodiless response whose
 * bytes the transport left encoded: a HEAD's length is still true), and a
 * decoded body loses its `Content-Encoding`.
 */
export function forwardResponseHeaders(
  headers: HeaderList,
  opts: { encodedBodies: boolean; bodiless: boolean }
): Array<readonly [string, string]> {
  const drop = dropped(headers);
  if (!opts.encodedBodies) drop.add('content-encoding');
  if (!(opts.encodedBodies && opts.bodiless)) drop.add('content-length');
  return headers.filter(([name]) => !drop.has(name.toLowerCase()));
}

/** Whether the client keeps the connection after this request. */
function keepsAlive(req: RequestHead): boolean {
  const tokens = fieldTokens(req.headers, 'connection');
  if (tokens.includes('close')) return false;
  return req.minor >= 1 || tokens.includes('keep-alive');
}

/**
 * The URL a request inside a tunnel for `origin` names: origin-form, or
 * absolute for that origin; its `Host` must name the origin too (421).
 */
export function tunnelRequestUrl(req: RequestHead, origin: string): string {
  const base = new URL(origin);
  let url: URL;
  try {
    url = new URL(req.target, req.target.startsWith('/') ? base : undefined);
  } catch {
    throw new HttpError(400, 'malformed request target');
  }
  const hosts = fieldValues(req.headers, 'host');
  const hostOk = hosts.every(
    (h) => URL.canParse(`https://${h}`) && new URL(`https://${h}`).host === base.host
  );
  if (url.origin !== base.origin || !hostOk) {
    throw new HttpError(421, `this tunnel is for ${base.host}`);
  }
  return url.href;
}

/** The absolute URL a proxy request names; its errors are the client's. */
export function requestUrl(req: RequestHead): string {
  if (req.target.startsWith('/')) {
    throw new HttpError(400, 'this is a proxy: send the absolute URL (GET http://host/path)');
  }
  let url: URL;
  try {
    url = new URL(req.target);
  } catch {
    throw new HttpError(400, 'malformed request target');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, `unsupported scheme ${url.protocol}`);
  }
  if (isLoopbackHost(url.hostname)) {
    throw new HttpError(
      403,
      `${url.hostname} is the realm's own loopback, which the proxy does not reach: list it in no_proxy`
    );
  }
  return url.href;
}

/** `host:port` of a CONNECT (a DNS name or IPv4 address, and a port). */
export function tunnelTarget(req: RequestHead): TunnelTarget {
  const match = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/.exec(req.target);
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65535) {
    throw new HttpError(400, 'CONNECT needs host:port');
  }
  const host = canonicalHost(match[1]);
  if (host === undefined) throw new HttpError(400, 'CONNECT needs host:port');
  if (isLoopbackHost(host)) {
    throw new HttpError(
      403,
      `${host} is the realm's own loopback, which the proxy does not reach: list it in no_proxy`
    );
  }
  return { host, port };
}

/** Abort `abort` once the client's socket hangs up (it can read no response); stop with `until`. */
export async function watchHangup(
  conn: KernelSocket,
  abort: AbortController,
  until: AbortSignal
): Promise<void> {
  while (!until.aborted && !abort.signal.aborted) {
    if (conn.poll().hangup) {
      abort.abort(new KernelError('EPIPE'));
      return;
    }
    try {
      await conn.changed(until);
    } catch {
      return;
    }
  }
}

/** `response`, unless `signal` fires first; a response that arrives after that is dropped. */
function untilAborted(
  response: Promise<RealmTransportResponse>,
  signal: AbortSignal
): Promise<RealmTransportResponse> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new KernelError('EINTR'));
      response.then((late) => late.cancel()).catch(() => undefined);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    response.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** What one connection's (or tunnel's) requests are read from and answered to. */
interface Exchange {
  sink: HttpSink;
  incoming: Incoming;
  /** Inside a tunnel: the origin its requests are for. */
  origin?: string;
  /** The client's socket, where CONNECT may take over (not inside a tunnel). */
  conn?: KernelSocket;
  /** The client's socket underneath it all: watched for a hangup while the upstream is asked. */
  socket: KernelSocket;
}

/** A synthesized response (the proxy's own errors). */
function plainResponse(status: number, message: string): RealmTransportResponse {
  const body = latin1Bytes(`slicc realm proxy: ${message}\n`);
  return {
    status,
    statusText: REASON[status] ?? '',
    headers: [['Content-Type', 'text/plain; charset=utf-8']],
    body: (async function* () {
      yield body;
    })(),
    cancel: async () => undefined,
  };
}

/** Reads that fail (EINTR) after `idleMs` without a byte, or when `stop` fires. */
function timedSource(conn: KernelSocket, idleMs: number, stop: AbortSignal): ByteSource {
  return {
    read: (max, signal) =>
      conn.read(
        max,
        AbortSignal.any([stop, AbortSignal.timeout(idleMs), ...(signal ? [signal] : [])])
      ),
  };
}

export class RealmProxy {
  private readonly listener: KernelSocket;
  private readonly stop = new AbortController();
  private readonly limits: ProxyLimits;
  private readonly slots: Budget;
  private readonly bodies: Budget;
  private readonly connections = new Set<KernelSocket>();
  /** Resolves once the listener is closed and every connection is done. */
  readonly closed: Promise<void>;
  readonly port: number;

  constructor(private readonly options: RealmProxyOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.slots = new Budget(this.limits.maxConnections);
    this.bodies = new Budget(this.limits.bodyBudget);
    this.listener = options.net.listen({
      family: 'inet',
      host: options.host ?? '127.0.0.1',
      port: options.port ?? REALM_PROXY_PORT,
    });
    this.port = this.listener.local?.family === 'inet' ? this.listener.local.port : 0;
    this.closed = this.acceptLoop();
  }

  get stopped(): boolean {
    return this.stop.signal.aborted;
  }

  /** Stop listening, abort every exchange, close every connection. */
  close(): void {
    if (this.stop.signal.aborted) return;
    this.stop.abort();
    this.listener.close();
    for (const conn of this.connections) conn.close();
  }

  private async acceptLoop(): Promise<void> {
    const served = new Set<Promise<void>>();
    try {
      for (;;) {
        await this.slots.acquire(1, this.stop.signal);
        let conn: KernelSocket;
        try {
          conn = await this.listener.accept(this.stop.signal);
        } catch {
          this.slots.release(1);
          break;
        }
        const done = this.serve(conn).finally(() => {
          this.slots.release(1);
          served.delete(done);
        });
        served.add(done);
      }
    } catch {
      // Stopped while waiting for a slot.
    }
    await Promise.allSettled([...served]);
  }

  private async serve(conn: KernelSocket): Promise<void> {
    this.connections.add(conn);
    const incoming = new Incoming(timedSource(conn, this.limits.idleMs, this.stop.signal));
    try {
      await this.requests({ sink: conn, incoming, conn, socket: conn });
    } finally {
      this.connections.delete(conn);
      conn.close();
    }
  }

  /** The requests on one connection (or in one tunnel), answered in order. */
  private async requests(ctx: Exchange): Promise<void> {
    try {
      for (;;) {
        const head = await ctx.incoming.head(this.limits.maxHead);
        if (!head || !(await this.exchange(ctx, head))) break;
      }
    } catch (e) {
      if (e instanceof HttpError) await this.refuse(ctx.sink, e);
      // Anything else (EINTR on the idle timer or a stop, EPIPE): the connection just ends.
    }
  }

  /** Answer a request the proxy cannot serve, then close. */
  private async refuse(sink: HttpSink, error: HttpError): Promise<void> {
    try {
      await this.relay(sink, 'GET', 1, plainResponse(error.status, error.message), false);
    } catch {
      // The client is gone.
    }
  }

  /** One request and its response; whether the connection carries another. */
  private async exchange(ctx: Exchange, head: Uint8Array): Promise<boolean> {
    const { sink: conn, incoming } = ctx;
    const req = parseRequestHead(head);
    if (req.method === 'CONNECT') {
      if (!ctx.conn) throw new HttpError(400, 'CONNECT inside a tunnel');
      await this.connect(ctx.conn, incoming, req);
      return false;
    }
    const url = ctx.origin ? tunnelRequestUrl(req, ctx.origin) : requestUrl(req);
    const keep = keepsAlive(req);
    const framing = requestFraming(req.headers);
    const reserve =
      framing.kind === 'length' ? framing.length : framing.kind === 'chunked' ? this.cap() : 0;
    if (reserve > this.cap()) throw new HttpError(413, `request body over ${this.cap()} bytes`);
    await this.expectContinue(conn, req, framing.kind !== 'none');
    await this.bodies.acquire(reserve, this.stop.signal);
    let response: RealmTransportResponse;
    const abort = new AbortController();
    const stopExchange = () => abort.abort();
    this.stop.signal.addEventListener('abort', stopExchange, { once: true });
    try {
      try {
        const body = await readBody(incoming, framing, this.cap());
        // While the upstream is asked, nothing reads the client: watch for it
        // hanging up, so a client that left does not hold a slot for as long
        // as an upstream takes (or forever, when it never answers).
        const waiting = new AbortController();
        void watchHangup(ctx.socket, abort, waiting.signal);
        try {
          response = await this.upstream(req, url, body, abort.signal);
        } finally {
          waiting.abort();
        }
      } finally {
        this.bodies.release(reserve);
      }
      return await this.relay(conn, req.method, req.minor, response, keep);
    } finally {
      this.stop.signal.removeEventListener('abort', stopExchange);
      abort.abort();
    }
  }

  private cap(): number {
    return this.options.transport.traits.maxRequestBody;
  }

  /** `Expect: 100-continue`: the go-ahead before the client sends its body. */
  private async expectContinue(conn: HttpSink, req: RequestHead, hasBody: boolean): Promise<void> {
    const expect = fieldTokens(req.headers, 'expect');
    if (expect.length === 0) return;
    if (expect.length !== 1 || expect[0] !== '100-continue') {
      throw new HttpError(417, `unsupported expectation: ${expect.join(', ')}`);
    }
    if (hasBody && req.minor >= 1) {
      await conn.write(latin1Bytes('HTTP/1.1 100 Continue\r\n\r\n'), this.stop.signal);
    }
  }

  /** The upstream's response, or the proxy's 502 when there is none. */
  private async upstream(
    req: RequestHead,
    url: string,
    body: Uint8Array | undefined,
    signal: AbortSignal
  ): Promise<RealmTransportResponse> {
    try {
      const fetching = this.options.transport.fetch({
        url,
        method: req.method.toUpperCase(),
        headers: forwardRequestHeaders(req.headers),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        signal,
      });
      // A transport that does not heed the signal must not hold the exchange.
      return await untilAborted(fetching, signal);
    } catch (e) {
      // Stopped, or the client left: nobody to answer.
      if (signal.aborted) throw e;
      const message = e instanceof Error ? e.message : String(e);
      return plainResponse(502, message || 'upstream request failed');
    }
  }

  /** Write a response; whether the connection stays open for another request. */
  private async relay(
    conn: HttpSink,
    method: string,
    minor: number,
    response: RealmTransportResponse,
    keepAlive: boolean
  ): Promise<boolean> {
    const status = response.status;
    const bodiless = method === 'HEAD' || status === 204 || status === 304 || status < 200;
    const headers = forwardResponseHeaders(response.headers, {
      encodedBodies: this.options.transport.traits.encodedBodies,
      bodiless,
    });
    // An HTTP/1.0 client has no chunked coding: the body ends where the connection does.
    const chunked = !bodiless && minor >= 1;
    const keep = keepAlive && (bodiless || chunked);
    headers.push(['Connection', keep ? 'keep-alive' : 'close']);
    if (chunked) headers.push(['Transfer-Encoding', 'chunked']);
    const signal = this.stop.signal;
    await conn.write(
      responseHead(status, response.statusText || REASON[status] || '', headers),
      signal
    );
    if (bodiless) {
      await response.cancel();
      return keep;
    }
    try {
      for await (const piece of response.body) {
        if (piece.length > 0) await conn.write(chunked ? chunk(piece) : piece, signal);
      }
    } catch {
      // The upstream failed mid-body, or the client went away: end the
      // connection without the last chunk, so the client sees the cut.
      await response.cancel().catch(() => undefined);
      return false;
    }
    if (chunked) await conn.write(LAST_CHUNK, signal);
    return keep;
  }

  private async connect(conn: KernelSocket, incoming: Incoming, req: RequestHead): Promise<void> {
    const target = tunnelTarget(req);
    const tunnel = this.options.tunnel;
    if (!tunnel) {
      throw new HttpError(
        501,
        `CONNECT ${target.host}:${target.port}: no tunnels through this proxy`
      );
    }
    await conn.write(latin1Bytes('HTTP/1.1 200 Connection Established\r\n\r\n'), this.stop.signal);
    try {
      await tunnel(conn, incoming, target, this.stop.signal, (source, sink, origin) =>
        this.requests({ sink, incoming: new Incoming(source), origin, socket: conn })
      );
    } catch (e) {
      // Past the 200 the connection is the tunnel's: its failure ends it, and
      // nothing more may be written. A kernel error (EPIPE, EINTR) is a plain end.
      if (!(e instanceof KernelError))
        log.warn('tunnel failed', { host: target.host, error: String(e) });
    }
  }
}
