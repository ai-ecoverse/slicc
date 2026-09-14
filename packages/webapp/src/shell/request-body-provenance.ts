const TTL_MS = 10_000;

const MAX_PARKED_BYTES = 8 * 1024 * 1024;

interface ParkedRead {
  bytes: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
}

const parked = new Map<string, ParkedRead>();
let parkedBytes = 0;

const ambiguous = new Set<string>();

function drop(text: string): void {
  const entry = parked.get(text);
  if (!entry) return;
  clearTimeout(entry.timer);
  parked.delete(text);
  parkedBytes -= entry.bytes.byteLength;
}

function hasHighByte(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte >= 0x80) return true;
  }
  return false;
}

function stripNewlines(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  let length = 0;
  for (const byte of bytes) {
    if (byte !== 0x0a && byte !== 0x0d) out[length++] = byte;
  }
  return out.slice(0, length);
}

export function parkReadBytes(text: string, bytes: Uint8Array): void {
  parkOne(text, bytes);
  const withoutNewlines = text.replace(/[\r\n]/g, '');
  if (withoutNewlines !== text) parkOne(withoutNewlines, stripNewlines(bytes));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function parkOne(text: string, bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PARKED_BYTES) return;
  if (!hasHighByte(bytes)) return;
  if (ambiguous.has(text)) return;
  const existing = parked.get(text);
  if (existing && !sameBytes(existing.bytes, bytes)) {
    drop(text);
    ambiguous.add(text);
    return;
  }
  drop(text);

  for (const key of parked.keys()) {
    if (parkedBytes + bytes.byteLength <= MAX_PARKED_BYTES) break;
    drop(key);
  }
  parked.set(text, {
    bytes,
    timer: setTimeout(() => drop(text), TTL_MS),
  });
  parkedBytes += bytes.byteLength;
}

export function lookupReadBytes(text: string): Uint8Array | null {
  return parked.get(text)?.bytes ?? null;
}

export function clearReadByteProvenance(): void {
  for (const key of [...parked.keys()]) drop(key);
  ambiguous.clear();
}
