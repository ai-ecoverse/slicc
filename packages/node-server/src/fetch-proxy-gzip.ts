import { Transform, type TransformCallback } from 'node:stream';
import { createGunzip, type Gunzip } from 'node:zlib';

export const GZIP_MAGIC_0 = 0x1f;
export const GZIP_MAGIC_1 = 0x8b;

export function contentEncodingLooksUncompressed(value: string | null | undefined): boolean {
  const encoding = (value ?? '').trim().toLowerCase();
  return encoding === '' || encoding === 'identity';
}

export function bufferStartsWithGzipMagic(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

export interface MaybeGunzipOptions {
  onDecided?: (inflating: boolean) => void;
}

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

      this.#decided = true;
      this.#onDecided?.(false);
      cb(null, this.#head);
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
