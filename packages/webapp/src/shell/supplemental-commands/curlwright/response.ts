import { base64ToUint8 } from '@slicc/shared-ts';

export function decodeBody(body: unknown, encoding: string | undefined): Uint8Array {
  if (typeof body !== 'string') return new Uint8Array(0);
  if (encoding !== 'base64') return new TextEncoder().encode(body);
  return base64ToUint8(body);
}

export function statusLine(status: number, statusText: string): string {
  return statusText ? `HTTP/1.1 ${status} ${statusText}` : `HTTP/1.1 ${status}`;
}

export function formatHeaderBlock(
  status: number,
  statusText: string,
  headers: Record<string, string>
): string {
  const lines = [statusLine(status, statusText)];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

export const BINARY_OUTPUT_WARNING =
  'Warning: Binary output can mess up your terminal. Use "--output -" to tell\n' +
  'Warning: curlwright to output it to your terminal anyway, or consider\n' +
  'Warning: "--output <FILE>" to save to a file.\n';

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

export function headerBlockSize(
  status: number,
  statusText: string,
  headers: Record<string, string>
): number {
  return new TextEncoder().encode(formatHeaderBlock(status, statusText, headers)).length;
}
