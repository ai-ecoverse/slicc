import * as pako from 'pako';
import { bufferFrom } from './buffer-from.js';

type ZlibInput = string | ArrayBufferView | ArrayBuffer;
interface ZlibOptions {
  level?: number;
  windowBits?: number;
  memLevel?: number;
  strategy?: number;
}
type PakoFn = (data: Uint8Array, opts?: ZlibOptions) => Uint8Array;
type ZlibCallback = (error: Error | null, result?: Buffer) => void;

function zlibToBytes(data: ZlibInput): Uint8Array {
  if (typeof data === 'string') return new Uint8Array(bufferFrom(data, 'utf8'));
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

function zlibPakoOpts(opts?: ZlibOptions): ZlibOptions {
  const out: ZlibOptions = {};
  if (opts) {
    if (typeof opts.level === 'number') out['level'] = opts.level;
    if (typeof opts.windowBits === 'number') out['windowBits'] = opts.windowBits;
    if (typeof opts.memLevel === 'number') out['memLevel'] = opts.memLevel;
    if (typeof opts.strategy === 'number') out['strategy'] = opts.strategy;
  }
  return out;
}

function zlibSync(fn: PakoFn, data: ZlibInput, opts?: ZlibOptions): Buffer {
  return bufferFrom(fn(zlibToBytes(data), zlibPakoOpts(opts)));
}

function zlibAsync(
  fn: PakoFn,
  data: ZlibInput,
  optsOrCb: ZlibOptions | ZlibCallback | undefined,
  maybeCb?: ZlibCallback
): void {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ZlibCallback | undefined;
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
  if (typeof cb !== 'function') throw new TypeError('zlib: callback is required');
  let result: Buffer;
  try {
    result = zlibSync(fn, data, opts);
  } catch (err) {
    queueMicrotask(() => cb(err instanceof Error ? err : new Error(String(err))));
    return;
  }
  queueMicrotask(() => cb(null, result));
}

export interface NodeZlib {
  gzipSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  gunzipSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  deflateSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  inflateSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  deflateRawSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  inflateRawSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  gzip(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  gunzip(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  deflate(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  inflate(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  deflateRaw(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  inflateRaw(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  constants: Record<string, number>;
}

export const nodeZlib: NodeZlib = {
  gzipSync: (data, opts) => zlibSync(pako.gzip as PakoFn, data, opts),
  gunzipSync: (data, opts) => zlibSync(pako.ungzip as PakoFn, data, opts),
  deflateSync: (data, opts) => zlibSync(pako.deflate as PakoFn, data, opts),
  inflateSync: (data, opts) => zlibSync(pako.inflate as PakoFn, data, opts),
  deflateRawSync: (data, opts) => zlibSync(pako.deflateRaw as PakoFn, data, opts),
  inflateRawSync: (data, opts) => zlibSync(pako.inflateRaw as PakoFn, data, opts),
  gzip: (data, optsOrCb, cb) => zlibAsync(pako.gzip as PakoFn, data, optsOrCb, cb),
  gunzip: (data, optsOrCb, cb) => zlibAsync(pako.ungzip as PakoFn, data, optsOrCb, cb),
  deflate: (data, optsOrCb, cb) => zlibAsync(pako.deflate as PakoFn, data, optsOrCb, cb),
  inflate: (data, optsOrCb, cb) => zlibAsync(pako.inflate as PakoFn, data, optsOrCb, cb),
  deflateRaw: (data, optsOrCb, cb) => zlibAsync(pako.deflateRaw as PakoFn, data, optsOrCb, cb),
  inflateRaw: (data, optsOrCb, cb) => zlibAsync(pako.inflateRaw as PakoFn, data, optsOrCb, cb),
  constants: {
    Z_NO_FLUSH: 0,
    Z_BEST_SPEED: 1,
    Z_BEST_COMPRESSION: 9,
    Z_DEFAULT_COMPRESSION: -1,
  },
};
