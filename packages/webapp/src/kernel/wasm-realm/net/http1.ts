import type { HeaderList } from './transport.js';

export interface ByteSource {
  read(max: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const CR = 13;
const LF = 10;
const READ_SIZE = 64 * 1024;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const REASON: Readonly<Record<number, string>> = {
  100: 'Continue',
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  408: 'Request Timeout',
  411: 'Length Required',
  413: 'Content Too Large',
  417: 'Expectation Failed',
  431: 'Request Header Fields Too Large',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  505: 'HTTP Version Not Supported',
};

export class Incoming {
  private buf = new Uint8Array(0);
  private eof = false;

  constructor(private readonly source: ByteSource) {}

  get buffered(): number {
    return this.buf.length;
  }

  private async fill(signal?: AbortSignal): Promise<boolean> {
    if (this.eof) return false;
    const chunk = await this.source.read(READ_SIZE, signal);
    if (chunk.length === 0) {
      this.eof = true;
      return false;
    }
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
    return true;
  }

  private take(n: number): Uint8Array {
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async head(limit: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    let from = 0;
    for (;;) {
      const end = headEnd(this.buf, from);
      if (end > 0) {
        if (end > limit) throw new HttpError(431, 'request head too large');
        return this.take(end);
      }
      if (this.buf.length > limit) throw new HttpError(431, 'request head too large');
      from = Math.max(0, this.buf.length - 3);
      if (!(await this.fill(signal))) {
        if (this.buf.length === 0) return null;
        throw new HttpError(400, 'connection closed inside a request head');
      }
    }
  }

  async line(limit: number, signal?: AbortSignal): Promise<string> {
    let from = 0;
    for (;;) {
      const at = this.buf.indexOf(LF, from);
      if (at >= 0) {
        const line = this.take(at + 1);
        const text = latin1(line.subarray(0, line[at - 1] === CR ? at - 1 : at));
        return text;
      }
      if (this.buf.length > limit) throw new HttpError(400, 'line too long');
      from = this.buf.length;
      if (!(await this.fill(signal))) throw new HttpError(400, 'connection closed inside a body');
    }
  }

  async exactly(n: number, signal?: AbortSignal): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (!(await this.fill(signal))) throw new HttpError(400, 'connection closed inside a body');
    }
    return this.take(n);
  }
}

function headEnd(buf: Uint8Array, from: number): number {
  for (let i = from; i < buf.length; i++) {
    if (buf[i] !== LF) continue;
    if (buf[i + 1] === LF) return i + 2;
    if (buf[i + 1] === CR && buf[i + 2] === LF) return i + 3;
  }
  return 0;
}

export function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export interface RequestHead {
  method: string;
  target: string;

  minor: number;
  headers: HeaderList;
}

export function parseRequestHead(bytes: Uint8Array): RequestHead {
  const lines = latin1(bytes).split(/\r?\n/);

  while (lines.length > 0 && lines[0] === '') lines.shift();
  const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+) (\S+) HTTP\/(\d)\.(\d)$/.exec(lines.shift() ?? '');
  if (!match) throw new HttpError(400, 'malformed request line');
  if (match[3] !== '1') throw new HttpError(505, `HTTP/${match[3]}.${match[4]} is not supported`);
  return {
    method: match[1],
    target: match[2],
    minor: Number(match[4]),
    headers: parseFields(lines),
  };
}

function parseFields(lines: string[]): HeaderList {
  const headers: Array<readonly [string, string]> = [];
  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      throw new HttpError(400, 'obsolete line folding');
    }
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon) : '';
    if (!TOKEN.test(name)) throw new HttpError(400, 'malformed header field');
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return headers;
}

export function fieldValues(headers: HeaderList, name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter(([n]) => n.toLowerCase() === lower).map(([, v]) => v);
}

export function fieldTokens(headers: HeaderList, name: string): string[] {
  return fieldValues(headers, name)
    .flatMap((v) => v.split(','))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '');
}

export type BodyFraming =
  | { kind: 'none' }
  | { kind: 'length'; length: number }
  | { kind: 'chunked' };

export function requestFraming(headers: HeaderList): BodyFraming {
  const codings = fieldTokens(headers, 'transfer-encoding');
  const lengths = fieldValues(headers, 'content-length');
  if (codings.length > 0) {
    if (lengths.length > 0) throw new HttpError(400, 'both Transfer-Encoding and Content-Length');
    if (codings.length !== 1 || codings[0] !== 'chunked') {
      throw new HttpError(501, `unsupported Transfer-Encoding: ${codings.join(', ')}`);
    }
    return { kind: 'chunked' };
  }
  if (lengths.length === 0) return { kind: 'none' };
  const distinct = new Set(lengths.flatMap((v) => v.split(',')).map((v) => v.trim()));
  const [only] = distinct;
  if (distinct.size !== 1 || !/^\d{1,15}$/.test(only)) {
    throw new HttpError(400, 'invalid Content-Length');
  }
  const length = Number(only);
  return length === 0 ? { kind: 'none' } : { kind: 'length', length };
}

const MAX_CHUNK_LINE = 4096;
const MAX_TRAILERS = 64 * 1024;

export async function readBody(
  incoming: Incoming,
  framing: BodyFraming,
  cap: number,
  signal?: AbortSignal
): Promise<Uint8Array | undefined> {
  if (framing.kind === 'none') return undefined;
  if (framing.kind === 'length') {
    if (framing.length > cap) throw new HttpError(413, `request body over ${cap} bytes`);
    return incoming.exactly(framing.length, signal);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const sizeLine = await incoming.line(MAX_CHUNK_LINE, signal);
    const size = /^([0-9A-Fa-f]{1,12})[ \t]*(;.*)?$/.exec(sizeLine);
    if (!size) throw new HttpError(400, 'malformed chunk size');
    const n = Number.parseInt(size[1], 16);
    if (n === 0) break;
    total += n;
    if (total > cap) throw new HttpError(413, `request body over ${cap} bytes`);
    chunks.push(await incoming.exactly(n, signal));
    if ((await incoming.line(2, signal)) !== '') throw new HttpError(400, 'malformed chunk');
  }

  let trailers = 0;
  for (let line = await incoming.line(MAX_TRAILERS, signal); line !== ''; ) {
    trailers += line.length;
    if (trailers > MAX_TRAILERS) throw new HttpError(431, 'trailers too large');
    line = await incoming.line(MAX_TRAILERS, signal);
  }
  return concat(chunks, total);
}

export function concat(chunks: Uint8Array[], total = chunks.reduce((n, c) => n + c.length, 0)) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function safeValue(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

export function responseHead(status: number, reason: string, headers: HeaderList): Uint8Array {
  const phrase = /^[\t\x20-\x7e\x80-\xff]*$/.test(reason) ? reason : '';
  let head = `HTTP/1.1 ${status} ${phrase}\r\n`;
  for (const [name, value] of headers) {
    if (TOKEN.test(name) && safeValue(value)) head += `${name}: ${value}\r\n`;
  }
  return latin1Bytes(`${head}\r\n`);
}

export function chunk(bytes: Uint8Array): Uint8Array {
  const size = latin1Bytes(`${bytes.length.toString(16)}\r\n`);
  const out = new Uint8Array(size.length + bytes.length + 2);
  out.set(size);
  out.set(bytes, size.length);
  out[out.length - 2] = CR;
  out[out.length - 1] = LF;
  return out;
}

export const LAST_CHUNK = latin1Bytes('0\r\n\r\n');
