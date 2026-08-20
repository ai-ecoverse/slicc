/**
 * Port-streamed fetch-proxy wire protocol shared by the extension backend and
 * browser clients. Platform-agnostic on purpose so `@slicc/webapp` and
 * `@slicc/chrome-extension` both import it *downward* from here rather than the
 * webapp reaching *up* into the extension for a duplicate copy.
 */

/**
 * Request the page/SW side sends to the fetch-proxy backend. One `request` per
 * Port connection.
 */
export interface FetchProxyRequestMsg {
  type: 'request';
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  requestBodyTooLarge?: boolean;
}

/**
 * Port-streamed response protocol. The backend emits exactly one
 * `response-head` followed by 0..N `response-chunk`s + a terminating
 * `response-end`, OR a single `response-error` (terminal). Discriminated union
 * so both the emitters AND the consumer narrow on `type` exhaustively — typos
 * like `response-haed` no longer compile, and adding a new variant forces an
 * update at both ends.
 */
export type FetchProxyResponseMsg =
  | {
      type: 'response-head';
      status: number;
      statusText: string;
      headers: Record<string, string>;
    }
  | { type: 'response-chunk'; dataBase64: string }
  | { type: 'response-end' }
  | { type: 'response-error'; error: string };
