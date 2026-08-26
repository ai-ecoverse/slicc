/**
 * `curlwright` response shaping: the `-i`/`-D` header block, and the
 * decision of whether a body can be written to stdout at all.
 *
 * Bodies always arrive base64-encoded from the page (the command asks
 * `browser.fetch` for `responseType: 'binary'` unconditionally). That
 * is what makes `-o` byte-exact, and it also means text is decoded here
 * exactly once, from known bytes — never JSON-parsed and re-serialized,
 * so a body reaches stdout as the server wrote it.
 */

import { base64ToUint8 } from '@slicc/shared-ts';

/** Decode the base64 body a page-context fetch returns. */
export function decodeBody(body: unknown, encoding: string | undefined): Uint8Array {
  if (typeof body !== 'string') return new Uint8Array(0);
  if (encoding !== 'base64') return new TextEncoder().encode(body);
  return base64ToUint8(body);
}

/**
 * A synthesized status line. The page exposes no HTTP version — `fetch`
 * does not report it — so the block says `HTTP/1.1` the way curl does
 * for an HTTP/1.1 hop, and `-D` output is a faithful header dump rather
 * than a faithful wire dump. Callers comparing against a HAR should
 * compare the header lines, not this first one.
 */
export function statusLine(status: number, statusText: string): string {
  return statusText ? `HTTP/1.1 ${status} ${statusText}` : `HTTP/1.1 ${status}`;
}

/**
 * Format the header block curl prints for `-i`/`-I` and dumps for `-D`,
 * CRLF-terminated and closed by a blank line, as received.
 */
export function formatHeaderBlock(
  status: number,
  statusText: string,
  headers: Record<string, string>
): string {
  const lines = [statusLine(status, statusText)];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Whether these bytes would corrupt a terminal. Content-Type is not
 * consulted on purpose: servers mislabel, and the only question that
 * matters is whether the bytes survive a round trip through a string.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** curl's warning when a binary body would otherwise land on a terminal. */
export const BINARY_OUTPUT_WARNING =
  'Warning: Binary output can mess up your terminal. Use "--output -" to tell\n' +
  'Warning: curlwright to output it to your terminal anyway, or consider\n' +
  'Warning: "--output <FILE>" to save to a file.\n';

/**
 * Filename `-O` derives from a URL, matching curl: the last path
 * segment, query string excluded. A URL with no usable segment has no
 * remote name, which curl treats as a usage error.
 */
export function remoteName(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split('?')[0];
  }
  const segment = pathname.replace(/\/+$/, '').split('/').pop();
  return segment ? segment : null;
}

/** Byte length of the header block, for `%{size_header}`. */
export function headerBlockSize(
  status: number,
  statusText: string,
  headers: Record<string, string>
): number {
  return new TextEncoder().encode(formatHeaderBlock(status, statusText, headers)).length;
}
