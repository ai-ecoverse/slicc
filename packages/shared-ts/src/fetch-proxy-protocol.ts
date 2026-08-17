/**
 * Port-streamed fetch-proxy response protocol shared by the extension backend
 * and browser clients.
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
