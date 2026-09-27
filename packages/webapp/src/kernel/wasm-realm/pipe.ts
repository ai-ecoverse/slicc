export const PIPE_CAPACITY = 64 * 1024;

export class PipeError extends Error {
  constructor(readonly code: 'EPIPE') {
    super(code);
  }
}

export class KernelPipe {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private readers = 0;
  private writers = 0;
  private waiters: Array<() => void> = [];

  constructor(readonly capacity: number = PIPE_CAPACITY) {}

  get buffered(): number {
    return this.size;
  }

  get readReady(): boolean {
    return this.size > 0 || this.writers === 0;
  }

  get writeReady(): boolean {
    return this.size < this.capacity || this.readers === 0;
  }

  get writersGone(): boolean {
    return this.writers === 0;
  }

  get readersGone(): boolean {
    return this.readers === 0;
  }

  openRead(): void {
    this.readers += 1;
  }

  openWrite(): void {
    this.writers += 1;
  }

  closeRead(): void {
    if (this.readers > 0) this.readers -= 1;
    if (this.readers === 0) {
      this.chunks = [];
      this.size = 0;
    }
    this.wake();
  }

  closeWrite(): void {
    if (this.writers > 0) this.writers -= 1;
    this.wake();
  }

  async read(max: number): Promise<Uint8Array> {
    while (this.size === 0) {
      if (this.writers === 0) return new Uint8Array(0);
      await this.waitForChange();
    }
    const out = this.take(Math.min(max, this.size));
    this.wake();
    return out;
  }

  async write(bytes: Uint8Array): Promise<number> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.readers === 0) throw new PipeError('EPIPE');
      const room = this.capacity - this.size;
      if (room === 0) {
        await this.waitForChange();
        continue;
      }
      const n = Math.min(room, bytes.length - offset);
      this.chunks.push(bytes.slice(offset, offset + n));
      this.size += n;
      offset += n;
      this.wake();
    }
    return bytes.length;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const count = Math.min(head.length, n - filled);
      out.set(head.subarray(0, count), filled);
      filled += count;
      if (count === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(count);
    }
    this.size -= n;
    return out;
  }

  private waitForChange(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
