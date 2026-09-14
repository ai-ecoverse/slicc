import { md5 } from 'js-md5';
import { sha1 } from 'js-sha1';
import { sha256 } from 'js-sha256';
import { bufferFrom } from './buffer-from.js';

const MAX_RANDOM_BYTES = 65536;

export interface NodeHash {
  update(data: string | ArrayBufferView | ArrayBuffer, inputEncoding?: string): NodeHash;
  digest(): Uint8Array;
  digest(encoding: string): string;
}

export interface NodeCrypto {
  randomFillSync<T extends ArrayBufferView>(buffer: T, offset?: number, size?: number): T;
  randomBytes(size: number): Uint8Array;
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  createHash(algorithm: string): NodeHash;
  readonly webcrypto: Crypto;
  readonly subtle: SubtleCrypto;
}

interface IncrementalHasher {
  update(message: string | number[] | ArrayBuffer | Uint8Array): IncrementalHasher;
  array(): number[];
}
type HasherFactory = { create(): IncrementalHasher };

const HASH_FACTORIES: Record<string, HasherFactory> = {
  md5: md5 as unknown as HasherFactory,
  sha1: sha1 as unknown as HasherFactory,
  sha256: sha256 as unknown as HasherFactory,
};

function hashInput(
  data: string | ArrayBufferView | ArrayBuffer,
  inputEncoding?: string
): string | number[] | ArrayBuffer | Uint8Array {
  if (typeof data !== 'string') {
    return ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data;
  }
  if (
    inputEncoding === 'hex' ||
    inputEncoding === 'base64' ||
    inputEncoding === 'base64url' ||
    inputEncoding === 'latin1' ||
    inputEncoding === 'binary'
  ) {
    return new Uint8Array(bufferFrom(data, inputEncoding === 'binary' ? 'latin1' : inputEncoding));
  }
  return data;
}

function createHash(algorithm: string): NodeHash {
  const key = String(algorithm).toLowerCase().replace('-', '');
  const factory = HASH_FACTORIES[key];
  if (!factory) throw new Error(`Digest method not supported: ${algorithm}`);
  const hasher = factory.create();
  let finalized = false;
  const hash: NodeHash = {
    update(data, inputEncoding) {
      if (finalized) throw new Error('Digest already called');
      hasher.update(hashInput(data, inputEncoding));
      return hash;
    },
    digest(encoding?: string): never {
      finalized = true;
      const buf = bufferFrom(hasher.array());
      return (encoding ? buf.toString(encoding as BufferEncoding) : buf) as never;
    },
  };
  return hash;
}

function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('crypto: globalThis.crypto is unavailable in this environment');
  }
  return c;
}

function secureRandomValues<T extends ArrayBufferView>(view: T): T {
  return webCrypto().getRandomValues(view as ArrayBufferView<ArrayBuffer>) as T;
}

function fillRandomBytes(view: Uint8Array): void {
  for (let offset = 0; offset < view.length; offset += MAX_RANDOM_BYTES) {
    const end = Math.min(offset + MAX_RANDOM_BYTES, view.length);
    secureRandomValues(view.subarray(offset, end));
  }
}

function asByteView(buffer: ArrayBufferView): Uint8Array {
  return buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

const HEX_BYTES: string[] = Array.from({ length: 256 }, (_, i) =>
  (i + 0x100).toString(16).slice(1)
);

function cryptoRandomUUID(): string {
  const c = webCrypto();
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = secureRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return (
    `${HEX_BYTES[b[0]]}${HEX_BYTES[b[1]]}${HEX_BYTES[b[2]]}${HEX_BYTES[b[3]]}` +
    `-${HEX_BYTES[b[4]]}${HEX_BYTES[b[5]]}` +
    `-${HEX_BYTES[b[6]]}${HEX_BYTES[b[7]]}` +
    `-${HEX_BYTES[b[8]]}${HEX_BYTES[b[9]]}` +
    `-${HEX_BYTES[b[10]]}${HEX_BYTES[b[11]]}${HEX_BYTES[b[12]]}${HEX_BYTES[b[13]]}${HEX_BYTES[b[14]]}${HEX_BYTES[b[15]]}`
  );
}

export const nodeCrypto: NodeCrypto = {
  randomFillSync<T extends ArrayBufferView>(buffer: T, offset = 0, size?: number): T {
    const bytes = asByteView(buffer);
    const start = offset;
    const end = size === undefined ? bytes.length : start + size;
    fillRandomBytes(bytes.subarray(start, end));
    return buffer;
  },
  randomBytes(size: number): Uint8Array {
    const BufferCtor = (globalThis as { Buffer?: { allocUnsafe?: (n: number) => Uint8Array } })
      .Buffer;
    const buf =
      BufferCtor && typeof BufferCtor.allocUnsafe === 'function'
        ? BufferCtor.allocUnsafe(size)
        : new Uint8Array(size);
    fillRandomBytes(asByteView(buf));
    return buf;
  },
  randomUUID: cryptoRandomUUID,
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    return secureRandomValues(array);
  },
  createHash,
  get webcrypto(): Crypto {
    return webCrypto();
  },
  get subtle(): SubtleCrypto {
    return webCrypto().subtle;
  },
};
