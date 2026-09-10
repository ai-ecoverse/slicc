import { Transform, type TransformCallback } from 'node:stream';
import { createGunzip, type Gunzip } from 'node:zlib';

/** gzip member magic (`1f 8b`). */
export const GZIP_MAGIC_0 = 0x1f;
export const GZIP_MAGIC_1 = 0x8b;

/**
 * True when the upstream `content-encoding` does not claim a compressed
 * coding. Empty and `identity` both mean "the bytes are the representation"
 * — which is a lie when an edge returns cached gzip without the header
 * (#3037, AEM/Fastly).
 */
export function contentEncodingLooksUncompressed(value: string | null | undefined): boolean {
  const encoding = (value ?? '').trim().toLowerCase();
  return encoding === '' || encoding === 'identity';
}

export function bufferStartsWithGzipMagic(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

export interface MaybeGunzipOptions {
  /**
   * Fired once the first two bytes have been seen (or on empty EOF), before
   * any decoded bytes are pushed. `inflating` is true when gzip magic was
   * present and the rest of the body will go through zlib.
   */
  onDecided?: (inflating: boolean) => void;
}

/**
 * Peek-and-maybe-gunzip transform for `/api/fetch-proxy`.
 *
 * If the body starts with gzip magic, pipe through `zlib.createGunzip`.
 * Otherwise pass bytes through. The route only inserts this transform for
 * text content types so a real `application/gzip` / `.tar.gz` download is
 * not silently inflated.
 *
 * Declared `gzip`/`br` is usually already inflated by undici; sniffing
 * magic still catches the AEM/Fastly shape (gzip bytes, encoding
 * absent/`identity`). The inner Gunzip is paused when `push` returns
 * false so a highly compressible chunk cannot unbounded-buffer here.
 */
export function createMaybeGunzipStream(options: MaybeGunzipOptions = {}): Transform {
  return new MaybeGunzipTransform(options.onDecided);
}

class MaybeGunzipTransform extends Transform {
  #head = Buffer.alloc(0);
  #decided = false;
  #gunzip: Gunzip | null = null;
  readonly #onDecided: ((inflating: boolean) => void) | undefined;

  constructor(onDecided?: (inflating: boolean) => void) {
    super();
    this.#onDecided = onDecided;
    // Destination drained — let zlib produce more. Attached once so a
    // paused Gunzip cannot sit idle after `push` returned false.
    this.on('resume', () => {
      this.#gunzip?.resume();
    });
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.#gunzip) {
      this.#gunzip.write(chunk, cb);
      return;
    }
    if (this.#decided) {
      cb(null, chunk);
      return;
    }
    this.#head = Buffer.concat([this.#head, chunk]);
    if (this.#head.length < 2) {
      cb();
      return;
    }
    this.#finishDecide(cb);
  }

  override _flush(cb: TransformCallback): void {
    if (!this.#decided) {
      if (this.#head.length === 0) {
        this.#onDecided?.(false);
        cb();
        return;
      }
      this.#finishDecide((err) => {
        if (err) {
          cb(err);
          return;
        }
        this.#endGunzipOrFinish(cb);
      });
      return;
    }
    this.#endGunzipOrFinish(cb);
  }

  #finishDecide(cb: TransformCallback): void {
    this.#decided = true;
    const head = this.#head;
    this.#head = Buffer.alloc(0);
    if (!bufferStartsWithGzipMagic(head)) {
      this.#onDecided?.(false);
      cb(null, head);
      return;
    }
    this.#onDecided?.(true);
    const gunzip = createGunzip();
    this.#gunzip = gunzip;
    gunzip.on('data', (decoded: Buffer) => {
      if (!this.push(decoded)) {
        gunzip.pause();
      }
    });
    gunzip.on('error', (err: Error) => {
      this.destroy(err);
    });
    gunzip.write(head, cb);
  }

  #endGunzipOrFinish(cb: TransformCallback): void {
    const gunzip = this.#gunzip;
    if (!gunzip) {
      cb();
      return;
    }
    const onEnd = () => {
      gunzip.off('error', onError);
      cb();
    };
    const onError = (err: Error) => {
      gunzip.off('end', onEnd);
      cb(err);
    };
    gunzip.once('end', onEnd);
    gunzip.once('error', onError);
    gunzip.end();
  }
}
