type StreamListener = (...args: unknown[]) => void;

class StreamBase {
  private _events: Map<string, StreamListener[]> = new Map();
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

  pipe(dest: StreamBase): StreamBase {
    return dest;
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
    return this;
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
    return this;
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
    return this;
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
