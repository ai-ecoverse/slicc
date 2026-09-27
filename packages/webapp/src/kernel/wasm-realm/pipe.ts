/**
 * `pipe.ts` — the kernel's pipe(2): a bounded byte buffer between the
 * processes of the wasm realm (#3530), with POSIX blocking semantics.
 *
 * - `read` waits until there is data, then returns what is buffered (up to
 *   `max` bytes); with the buffer empty and every write end closed it returns
 *   an empty array: end of file.
 * - `write` waits while the buffer is full and returns once every byte is
 *   buffered; with every read end closed it fails with `EPIPE` (the writer's
 *   SIGPIPE is the caller's business).
 *
 * The ends are counted, not owned: every open file description that refers
 * to an end holds one reference (`open*` / `close*`), so a pipe inherited by
 * several processes reaches EOF only when the last writer lets go. Waiters are
 * promises, so a blocked reader never blocks the kernel; the process worker is
 * the one parked in `Atomics.wait` until its request resolves.
 */

/** Default capacity: Linux's 64 KiB. */
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

  /** Bytes buffered and not yet read. */
  get buffered(): number {
    return this.size;
  }

  openRead(): void {
    this.readers += 1;
  }

  openWrite(): void {
    this.writers += 1;
  }

  /** One read end closed: with none left, blocked writers fail with EPIPE. */
  closeRead(): void {
    if (this.readers > 0) this.readers -= 1;
    if (this.readers === 0) {
      this.chunks = [];
      this.size = 0;
    }
    this.wake();
  }

  /** One write end closed: with none left, readers drain the buffer, then EOF. */
  closeWrite(): void {
    if (this.writers > 0) this.writers -= 1;
    this.wake();
  }

  /** Up to `max` bytes; an empty array means end of file. */
  async read(max: number): Promise<Uint8Array> {
    while (this.size === 0) {
      if (this.writers === 0) return new Uint8Array(0);
      await this.waitForChange();
    }
    const out = this.take(Math.min(max, this.size));
    this.wake();
    return out;
  }

  /** Buffer every byte of `bytes`, waiting for room as needed. */
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
