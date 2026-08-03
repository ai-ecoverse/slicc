type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private _events: Map<string | symbol, Listener[]> = new Map();

  on(event: string | symbol, fn: Listener): this {
    const list = this._events.get(event);
    if (list) list.push(fn);
    else this._events.set(event, [fn]);
    return this;
  }

  addListener(event: string | symbol, fn: Listener): this {
    return this.on(event, fn);
  }

  off(event: string | symbol, fn: Listener): this {
    const list = this._events.get(event);
    if (list) {
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this._events.delete(event);
    }
    return this;
  }

  removeListener(event: string | symbol, fn: Listener): this {
    return this.off(event, fn);
  }

  once(event: string | symbol, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this._events.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) fn(...args);
    return true;
  }

  removeAllListeners(event?: string | symbol): this {
    if (event !== undefined) this._events.delete(event);
    else this._events.clear();
    return this;
  }

  listenerCount(event: string | symbol): number {
    return this._events.get(event)?.length ?? 0;
  }

  listeners(event: string | symbol): Listener[] {
    return [...(this._events.get(event) ?? [])];
  }
}

export const nodeEvents = Object.assign(EventEmitter, {
  EventEmitter,
  default: EventEmitter,
});
