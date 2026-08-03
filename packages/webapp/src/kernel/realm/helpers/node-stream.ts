type StreamListener = (...args: unknown[]) => void;

interface PipeDestination {
  write(chunk: unknown): unknown;
  end(): unknown;
}

class StreamBase {
  private _events: Map<string, StreamListener[]> = new Map();
  private closeScheduled = false;
  writable = true;
  readable = true;

  on(event: string, fn: StreamListener): this {
    const list = this._events.get(event);
    if (list) list.push(fn);
    else this._events.set(event, [fn]);
    return this;
  }

  once(event: string, fn: StreamListener): this {
    const wrapped: StreamListener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, fn: StreamListener): this {
    const list = this._events.get(event);
    if (list) {
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this._events.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) fn(...args);
    return true;
  }

  pipe<T extends PipeDestination>(dest: T): T {
    this.on('data', (chunk) => dest.write(chunk));
    this.once('end', () => dest.end());
    return dest;
  }

  protected closeOnDestroy(): this {
    if (this.closeScheduled) return this;
    this.closeScheduled = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  removeListener(event: string, fn: StreamListener): this {
    return this.off(event, fn);
  }

  removeAllListeners(): this {
    this._events.clear();
    return this;
  }
}

export class Readable extends StreamBase {
  read(): null {
    return null;
  }
  destroy(): this {
    return this.closeOnDestroy();
  }
}

class Writable extends StreamBase {
  write(_chunk: unknown, _encoding?: string, cb?: () => void): boolean {
    if (cb) queueMicrotask(cb);
    return true;
  }
  end(cb?: () => void): this {
    if (cb) queueMicrotask(cb);
    return this;
  }
  destroy(): this {
    return this.closeOnDestroy();
  }
}

class Transform extends StreamBase {
  write(_chunk: unknown, _encoding?: string, cb?: () => void): boolean {
    if (cb) queueMicrotask(cb);
    return true;
  }
  end(cb?: () => void): this {
    if (cb) queueMicrotask(cb);
    return this;
  }
  read(): null {
    return null;
  }
  destroy(): this {
    return this.closeOnDestroy();
  }
}

class PassThrough extends Transform {}

export const nodeStream = {
  Readable,
  Writable,
  Transform,
  PassThrough,
  Stream: StreamBase,
};
