export type Signer = (tbs: Uint8Array) => Promise<Uint8Array>;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, ...contents: readonly Uint8Array[]): Uint8Array {
  const body = concat(contents);
  return concat([Uint8Array.of(tag), length(body.length), body]);
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
const set = (...parts: Uint8Array[]) => tlv(0x31, ...parts);
const octets = (bytes: Uint8Array) => tlv(0x04, bytes);
const bits = (bytes: Uint8Array, unused = 0) => tlv(0x03, Uint8Array.of(unused), bytes);
const TRUE = tlv(0x01, Uint8Array.of(0xff));

export function integer(magnitude: Uint8Array): Uint8Array {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const trimmed = magnitude.subarray(start);
  return tlv(0x02, trimmed[0] & 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed);
}

export function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const arc of rest) {
    const groups: number[] = [];
    for (let v = arc; ; v = Math.floor(v / 128)) {
      groups.unshift(v & 0x7f);
      if (v < 128) break;
    }
    out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Uint8Array.from(out));
}

const utf8 = (text: string) => tlv(0x0c, new TextEncoder().encode(text));
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0x7f);

function time(date: Date): Uint8Array {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const year = date.getUTCFullYear();
  return year < 2050 ? tlv(0x17, ascii(`${iso.slice(2)}Z`)) : tlv(0x18, ascii(`${iso}Z`));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

export interface DistinguishedName {
  commonName: string;
  organization?: string;
}

function name(dn: DistinguishedName): Uint8Array {
  const rdns = [];
  if (dn.organization) rdns.push(set(seq(oid('2.5.4.10'), utf8(dn.organization))));
  rdns.push(set(seq(oid('2.5.4.3'), utf8(dn.commonName))));
  return seq(...rdns);
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical ? seq(oid(id), TRUE, octets(value)) : seq(oid(id), octets(value));
}

export function children(der: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const [, bodyStart, bodyEnd] = header(der, 0);
  for (let at = bodyStart; at < bodyEnd; ) {
    const [, , end] = header(der, at);
    out.push(der.subarray(at, end));
    at = end;
  }
  return out;
}

function header(der: Uint8Array, at: number): [tag: number, start: number, end: number] {
  const tag = der[at];
  let len = der[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + der[start + i];
    start += count;
  }
  if (start + len > der.length) throw new Error('truncated DER');
  return [tag, start, start + len];
}

export function contents(element: Uint8Array): Uint8Array {
  const [, start, end] = header(element, 0);
  return element.subarray(start, end);
}

export function publicKeyBits(spki: Uint8Array): Uint8Array {
  const key = children(spki)[1];
  return contents(key).subarray(1);
}

export async function keyId(spki: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-1', publicKeyBits(spki) as Uint8Array<ArrayBuffer>)
  );
}

export function ecdsaDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return seq(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}

export function randomSerial(): Uint8Array {
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0] & 0x7f) | 0x01;
  return serial;
}

export function ipv4(host: string): Uint8Array | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? Uint8Array.from(parts) : undefined;
}

export function ipv6(host: string): Uint8Array | undefined {
  if (!host.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(host)) return undefined;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  let text = host;
  const tail: number[] = [];
  if (v4) {
    const bytes = ipv4(v4[1]);
    if (!bytes) return undefined;
    tail.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
    text = host.slice(0, -v4[1].length).replace(/:$/, host.endsWith(`::${v4[1]}`) ? ':' : '');
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const back = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...back].every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return undefined;
  const words = [...head, ...back].map((g) => Number.parseInt(g, 16));
  const missing = 8 - words.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [
    ...head.map((g) => Number.parseInt(g, 16)),
    ...new Array(halves.length === 2 ? missing : 0).fill(0),
    ...back.map((g) => Number.parseInt(g, 16)),
    ...tail,
  ];
  return Uint8Array.from(all.flatMap((w) => [w >> 8, w & 0xff]));
}

export interface CertificateRequest {
  serial: Uint8Array;
  issuer: DistinguishedName;
  subject: DistinguishedName;
  notBefore: Date;
  notAfter: Date;

  spki: Uint8Array;

  issuerSpki: Uint8Array;

  kind: { ca: true } | { ca: false; host: string };
  sign: Signer;
}

async function extensions(req: CertificateRequest): Promise<Uint8Array> {
  const list = [extension('2.5.29.14', false, octets(await keyId(req.spki)))];
  if (req.kind.ca) {
    list.push(extension('2.5.29.19', true, seq(TRUE, integer(Uint8Array.of(0)))));

    list.push(extension('2.5.29.15', true, bits(Uint8Array.of(0x86), 1)));
  } else {
    list.push(extension('2.5.29.35', false, seq(tlv(0x80, await keyId(req.issuerSpki)))));
    list.push(extension('2.5.29.19', true, seq()));
    list.push(extension('2.5.29.15', true, bits(Uint8Array.of(0x80), 7)));
    list.push(extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))));
    const ip = ipv4(req.kind.host) ?? ipv6(req.kind.host);
    const altName = ip ? tlv(0x87, ip) : tlv(0x82, ascii(req.kind.host));
    list.push(extension('2.5.29.17', false, seq(altName)));
  }
  return tlv(0xa3, seq(...list));
}

export async function certificate(req: CertificateRequest): Promise<Uint8Array> {
  const tbs = seq(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(req.serial),
    ECDSA_SHA256,
    name(req.issuer),
    seq(time(req.notBefore), time(req.notAfter)),
    name(req.subject),
    req.spki,
    await extensions(req)
  );
  const signature = ecdsaDer(await req.sign(tbs));
  return seq(tbs, ECDSA_SHA256, bits(signature));
}

export function pem(der: Uint8Array): string {
  let b64 = '';
  for (let i = 0; i < der.length; i += 0x8000) {
    b64 += String.fromCharCode(...der.subarray(i, i + 0x8000));
  }
  const lines = btoa(b64).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}
