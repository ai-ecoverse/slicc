import { uint8ToBase64 } from '@slicc/shared-ts';

const TYPE_NAME_TO_NUM: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
};

export interface DnsAnswer {
  name: string;
  type: number;
  TTL?: number;
  data: string;
}

export interface DnsResponse {
  Status: number;
  Answer?: DnsAnswer[];
}

interface DecodedName {
  name: string;
  labels: string[];
  nextOffset: number;
}

interface DecodedRecords {
  answers: DnsAnswer[];
  nextOffset: number;
}

const UNSAFE_ASCII_LABEL_CHARACTERS = new Set('#/:<>?@[\\]^|');

function hasUnsafeAsciiCharacter(label: string): boolean {
  return Array.from(label).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x7f &&
      (codePoint < 0x21 || codePoint === 0x7f || UNSAFE_ASCII_LABEL_CHARACTERS.has(character))
    );
  });
}

function asciiLabel(label: string): string {
  if (hasUnsafeAsciiCharacter(label)) throw new Error('invalid hostname');
  if (/^[\x21-\x7e]+$/.test(label)) return label;

  const sentinelSuffix = '.invalid';
  const url = new URL(`https://${label}${sentinelSuffix}`);
  if (
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(sentinelSuffix) ||
    url.hostname.includes(':')
  ) {
    throw new Error('invalid hostname');
  }
  const hostname = url.hostname.slice(0, -sentinelSuffix.length);
  if (!hostname || hostname.includes('.') || !/^[\x21-\x7e]+$/.test(hostname)) {
    throw new Error('invalid hostname');
  }
  return hostname;
}

function asciiName(name: string): string {
  if (name === '.') return '';
  const bareName = name.endsWith('.') ? name.slice(0, -1) : name;
  const labels = bareName.split('.');
  if (!bareName || labels.some((label) => label.length === 0)) {
    throw new Error(`invalid DNS name: ${name}`);
  }
  try {
    return labels.map(asciiLabel).join('.');
  } catch {
    throw new Error(`invalid DNS name: ${name}`);
  }
}

function encodeQuery(name: string, type: string): Uint8Array {
  const labels = asciiName(name)
    .split('.')
    .filter((label) => label.length > 0)
    .map((label) => new TextEncoder().encode(label));
  if (labels.some((label) => label.length > 63)) throw new Error(`invalid DNS name: ${name}`);
  const nameLength = labels.reduce((total, label) => total + label.length + 1, 1);
  if (nameLength > 255) throw new Error(`invalid DNS name: ${name}`);
  const typeNumber = TYPE_NAME_TO_NUM[type];
  if (!typeNumber) throw new Error(`unsupported record type: ${type}`);

  const query = new Uint8Array(12 + nameLength + 4);
  const view = new DataView(query.buffer);
  view.setUint16(2, 0x0100);
  view.setUint16(4, 1);
  let offset = 12;
  for (const label of labels) {
    query[offset] = label.length;
    query.set(label, offset + 1);
    offset += label.length + 1;
  }
  offset += 1;
  view.setUint16(offset, typeNumber);
  view.setUint16(offset + 2, 1);
  return query;
}

export function buildDnsMessageUrl(resolverUrl: string, name: string, type: string): string {
  const base64url = uint8ToBase64(encodeQuery(name, type))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `${resolverUrl}?dns=${base64url}`;
}

function requireBytes(bytes: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error('truncated DNS message');
  }
}

function readName(bytes: Uint8Array, startOffset: number): DecodedName {
  const labels: string[] = [];
  const visited = new Set<number>();
  let offset = startOffset;
  let nextOffset = startOffset;
  let jumped = false;
  let wireLength = 1;
  for (let steps = 0; steps <= bytes.length; steps += 1) {
    requireBytes(bytes, offset, 1);
    const length = bytes[offset];
    if (length === 0) {
      if (!jumped) nextOffset = offset + 1;
      return { name: labels.length > 0 ? `${labels.join('.')}.` : '.', labels, nextOffset };
    }
    if ((length & 0xc0) === 0xc0) {
      requireBytes(bytes, offset, 2);
      const pointer = ((length & 0x3f) << 8) | bytes[offset + 1];
      if (pointer >= offset) throw new Error('invalid DNS compression pointer');
      if (visited.has(pointer)) throw new Error('DNS compression pointer loop');
      visited.add(pointer);
      if (!jumped) nextOffset = offset + 2;
      jumped = true;
      offset = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0 || length > 63) throw new Error('invalid DNS label');
    requireBytes(bytes, offset + 1, length);
    wireLength += length + 1;
    if (wireLength > 255) throw new Error('DNS name too long');
    labels.push(new TextDecoder().decode(bytes.subarray(offset + 1, offset + 1 + length)));
    offset += length + 1;
  }
  throw new Error('invalid DNS name');
}

function readUint16(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 2);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function formatIpv6(bytes: Uint8Array, offset: number): string {
  const words = Array.from({ length: 8 }, (_, index) => readUint16(bytes, offset + index * 2));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length; ) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - index > bestLength) [bestStart, bestLength] = [index, end - index];
    index = end;
  }
  const parts = words.map((word) => word.toString(16));
  if (bestLength < 2) return parts.join(':');
  return `${parts.slice(0, bestStart).join(':')}::${parts.slice(bestStart + bestLength).join(':')}`;
}

function escapeTxtSegment(bytes: Uint8Array, start: number, end: number): string {
  const escaped = Array.from(bytes.subarray(start, end), (byte) => {
    if (byte === 0x22) return '\\"';
    if (byte === 0x5c) return '\\\\';
    if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
    return `\\${String(byte).padStart(3, '0')}`;
  });
  return `"${escaped.join('')}"`;
}

function readTxtData(bytes: Uint8Array, start: number, end: number): string {
  let offset = start;
  const segments: string[] = [];
  while (offset < end) {
    const length = bytes[offset];
    requireBytes(bytes, offset + 1, length);
    if (offset + length + 1 > end) throw new Error('invalid TXT record');
    segments.push(escapeTxtSegment(bytes, offset + 1, offset + 1 + length));
    offset += length + 1;
  }
  return segments.join(' ');
}

function readCaaData(bytes: Uint8Array, start: number, end: number): string {
  if (end - start < 2) throw new Error('invalid CAA record');
  const tagLength = bytes[start + 1];
  if (start + 2 + tagLength > end) throw new Error('invalid CAA record');
  const decoder = new TextDecoder();
  const tag = decoder.decode(bytes.subarray(start + 2, start + 2 + tagLength));
  const value = decoder.decode(bytes.subarray(start + 2 + tagLength, end));
  return `${bytes[start]} ${tag} ${JSON.stringify(value)}`;
}

function readRecordData(bytes: Uint8Array, type: number, start: number, end: number): string {
  if (type === 1) {
    if (end - start !== 4) throw new Error('invalid A record');
    return Array.from(bytes.subarray(start, end)).join('.');
  }
  if (type === 28) {
    if (end - start !== 16) throw new Error('invalid AAAA record');
    return formatIpv6(bytes, start);
  }
  if ([2, 5, 12].includes(type)) {
    const decoded = readName(bytes, start);
    if (decoded.nextOffset !== end) throw new Error('invalid DNS name record');
    return decoded.name;
  }
  if (type === 15) {
    if (end - start < 3) throw new Error('invalid MX record');
    const decoded = readName(bytes, start + 2);
    if (decoded.nextOffset !== end) throw new Error('invalid MX record');
    return `${readUint16(bytes, start)} ${decoded.name}`;
  }
  if (type === 16) return readTxtData(bytes, start, end);
  if (type === 6) {
    const primary = readName(bytes, start);
    const mailbox = readName(bytes, primary.nextOffset);
    if (mailbox.nextOffset + 20 !== end) throw new Error('invalid SOA record');
    const values = Array.from({ length: 5 }, (_, index) =>
      readUint32(bytes, mailbox.nextOffset + index * 4)
    );
    return `${primary.name} ${mailbox.name} ${values.join(' ')}`;
  }
  if (type === 33) {
    if (end - start < 7) throw new Error('invalid SRV record');
    const target = readName(bytes, start + 6);
    if (target.nextOffset !== end) throw new Error('invalid SRV record');
    return `${readUint16(bytes, start)} ${readUint16(bytes, start + 2)} ${readUint16(bytes, start + 4)} ${target.name}`;
  }
  if (type === 257) return readCaaData(bytes, start, end);
  const hex = Array.from(bytes.subarray(start, end), (byte) => byte.toString(16).padStart(2, '0'));
  return `\\# ${end - start} ${hex.join('')}`;
}

function readRecords(
  bytes: Uint8Array,
  startOffset: number,
  count: number,
  collectAnswers: boolean
): DecodedRecords {
  const answers: DnsAnswer[] = [];
  let offset = startOffset;
  for (let index = 0; index < count; index += 1) {
    const owner = readName(bytes, offset);
    offset = owner.nextOffset;
    requireBytes(bytes, offset, 10);
    const type = readUint16(bytes, offset);
    const dnsClass = readUint16(bytes, offset + 2);
    const ttl = readUint32(bytes, offset + 4);
    const dataLength = readUint16(bytes, offset + 8);
    const dataStart = offset + 10;
    const dataEnd = dataStart + dataLength;
    requireBytes(bytes, dataStart, dataLength);
    const data = readRecordData(bytes, type, dataStart, dataEnd);
    if (collectAnswers && dnsClass === 1) {
      answers.push({ name: owner.name, type, TTL: ttl, data });
    }
    offset = dataEnd;
  }
  return { answers, nextOffset: offset };
}

function foldDnsLabel(label: string): string {
  return label.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function validateQuestion(
  question: DecodedName,
  type: number,
  dnsClass: number,
  name: string,
  expectedType: string
): void {
  const expectedLabels = asciiName(name).split('.').filter(Boolean);
  const nameMatches =
    question.labels.length === expectedLabels.length &&
    question.labels.every(
      (label, index) => foldDnsLabel(label) === foldDnsLabel(expectedLabels[index])
    );
  if (!nameMatches || type !== TYPE_NAME_TO_NUM[expectedType] || dnsClass !== 1) {
    throw new Error('unexpected DNS response question');
  }
}

export function parseDnsMessage(bytes: Uint8Array, name: string, type: string): DnsResponse {
  requireBytes(bytes, 0, 12);
  const flags = readUint16(bytes, 2);
  if (readUint16(bytes, 0) !== 0 || (flags & 0x8000) === 0) throw new Error('invalid DNS response');
  if ((flags & 0x0200) !== 0) throw new Error('truncated DNS response');
  const questionCount = readUint16(bytes, 4);
  const answerCount = readUint16(bytes, 6);
  const authorityCount = readUint16(bytes, 8);
  const additionalCount = readUint16(bytes, 10);
  if (questionCount !== 1) throw new Error('invalid DNS question count');
  let offset = 12;
  const question = readName(bytes, offset);
  offset = question.nextOffset;
  requireBytes(bytes, offset, 4);
  const questionType = readUint16(bytes, offset);
  const questionClass = readUint16(bytes, offset + 2);
  validateQuestion(question, questionType, questionClass, name, type);
  offset += 4;

  const answerRecords = readRecords(bytes, offset, answerCount, true);
  const authorityRecords = readRecords(bytes, answerRecords.nextOffset, authorityCount, false);
  const additionalRecords = readRecords(bytes, authorityRecords.nextOffset, additionalCount, false);
  if (additionalRecords.nextOffset !== bytes.length) throw new Error('trailing DNS message data');
  return { Status: flags & 0x000f, Answer: answerRecords.answers };
}
