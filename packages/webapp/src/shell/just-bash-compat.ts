import type { ByteString } from 'just-bash';

export type { ByteString } from 'just-bash';

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

export function stdinAsText(b: ByteString): string {
  const raw = b as unknown as string;
  if (raw.length === 0) return '';
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
  return utf8Decoder.decode(bytes);
}

export function stdinAsLatin1(b: ByteString): string {
  return b as unknown as string;
}

export function textAsStdin(s: string): ByteString {
  if (s.length === 0) return EMPTY_BYTES;
  const bytes = utf8Encoder.encode(s);
  const chars = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) chars[i] = String.fromCharCode(bytes[i]);
  return chars.join('') as unknown as ByteString;
}

export function bytesToStdin(bytes: Uint8Array): ByteString {
  if (bytes.length === 0) return EMPTY_BYTES;
  const chars = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) chars[i] = String.fromCharCode(bytes[i]!);
  return chars.join('') as unknown as ByteString;
}

export function stdinAsBytes(b: ByteString): Uint8Array {
  const latin1 = stdinAsLatin1(b);
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i) & 0xff;
  return bytes;
}

export function bytesAsStdout(bytes: Uint8Array): {
  stdout: string;
  stdoutKind: 'bytes';
  stdoutEncoding: 'binary';
} {
  return {
    stdout: stdinAsLatin1(bytesToStdin(bytes)),
    stdoutKind: 'bytes',
    stdoutEncoding: 'binary',
  };
}

export const EMPTY_BYTES: ByteString = '' as unknown as ByteString;
