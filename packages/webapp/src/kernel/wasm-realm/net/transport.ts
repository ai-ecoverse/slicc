/**
 * `transport.ts` — the contract between the wasm realm's HTTP proxy
 * (`proxy-service.ts`, #3571) and the float's way out: one HTTP exchange
 * handed to the outside world, the response handed back as it arrives.
 *
 * The proxy speaks HTTP/1.1 to native programs (curl, libcurl, git), so it
 * wants raw-ish fetch semantics from what carries a request out:
 *
 * - **manual redirects**: a 3xx reaches the client, which decides whether
 *   to follow it (`curl -L`, git's own redirect handling);
 * - **honest encodings**: the body bytes are what `Content-Encoding` says,
 *   so a client never inflates bytes that are already plain;
 * - **streamed response bodies**, so a large download holds one chunk at a
 *   time and backpressure reaches the upstream;
 * - **request bodies**, buffered for now (a streamed upload is a later step).
 *
 * {@link RealmTransportTraits} states which of these a transport delivers;
 * the proxy adapts to what it is told (it drops the length and coding of a
 * body the transport decoded, and refuses a request body over the cap). The
 * implementation over today's fetch path is `fetch-transport.ts`.
 */

/** Header fields in the order they came, each repeated field its own entry. */
export type HeaderList = ReadonlyArray<readonly [name: string, value: string]>;

export interface RealmTransportRequest {
  /** Absolute `http:` or `https:` URL. */
  url: string;
  /** Upper-case method token. */
  method: string;
  /** End-to-end request headers: no hop-by-hop fields, no `Host`, no `Content-Length`. */
  headers: HeaderList;
  /** The whole request body, when the method carries one. */
  body?: Uint8Array;
  /** Aborted when the client goes away or the service stops. */
  signal: AbortSignal;
}

export interface RealmTransportResponse {
  status: number;
  statusText: string;
  /** Response headers; repeated fields (`Set-Cookie`) stay separate entries. */
  headers: HeaderList;
  /** The body in order. Iterate once; breaking out early cancels the transfer. */
  body: AsyncIterable<Uint8Array>;
  /** Drop a body the caller will not read. */
  cancel(): Promise<void>;
}

/** What a transport guarantees, so the proxy knows what it forwards. */
export interface RealmTransportTraits {
  /**
   * True when a 3xx reaches the caller as is. False: the transport follows
   * redirects and the caller sees only the final response (a client's `-L`
   * then changes nothing, and a POST that was redirected is replayed by the
   * transport, not the client).
   */
  manualRedirects: boolean;
  /**
   * True when the body bytes are the upstream's wire representation (its
   * `Content-Encoding` still applies). False: the transport inflates coded
   * bodies, so `Content-Encoding` and `Content-Length` describe bytes the
   * caller never sees and the proxy drops them.
   */
  encodedBodies: boolean;
  /** Largest request body, in bytes, the transport accepts. */
  maxRequestBody: number;
}

export interface RealmTransport {
  readonly traits: RealmTransportTraits;
  /**
   * One exchange. Rejects when there is no response to give (the upstream is
   * unreachable, the route refused it, the signal fired); the message is
   * what the client is told, so it never carries a request's credentials.
   */
  fetch(request: RealmTransportRequest): Promise<RealmTransportResponse>;
}
