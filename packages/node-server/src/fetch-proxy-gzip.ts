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

/**
 * Peek-and-maybe-gunzip transform for `/api/fetch-proxy`.
 *
 * If the body starts with gzip magic, pipe through `zlib.createGunzip`.
 * Otherwise pass bytes through. Declared `gzip`/`br` is usually already
 * inflated by undici; sniffing magic still catches the AEM/Fastly shape
 * (gzip bytes, encoding absent/`identity`) and an HTTP client that did
 * not auto-decompress a declared gzip (Swift AsyncHTTPClient by default).
 *
 * The browser-facing hop is a synthetic SW `Response` (`llm-proxy-response`
 * / `new Response(body, { headers })`), which does **not** inflate
 * `content-encoding`. Delivering decoded bytes is the only shape that
 * parses as JS/CSS.
 */
export function createMaybeGunzipStream(): Transform {
  return new MaybeGunzipTransform();
}

class MaybeGunzipTransform extends Transform {
  #head = Buffer.alloc(0);
  #decided = false;
  #gunzip: Gunzip | null = null;

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
      cb(null, head);
      return;
    }
    const gunzip = createGunzip();
    this.#gunzip = gunzip;
    gunzip.on('data', (decoded: Buffer) => {
      this.push(decoded);
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
