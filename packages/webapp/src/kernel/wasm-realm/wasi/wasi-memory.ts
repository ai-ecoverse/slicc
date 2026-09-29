/**
 * `wasi-memory.ts` — the program's linear memory as the WASI host reads and
 * writes it: views taken fresh on every access (a `memory.grow` replaces the
 * buffer), strings, and scatter/gather over iovec arrays.
 */

const decoder = new TextDecoder();

export class WasiMemory {
  private memory: WebAssembly.Memory | undefined;

  bind(memory: WebAssembly.Memory): void {
    this.memory = memory;
  }

  private buffer(): ArrayBuffer {
    if (!this.memory) throw new Error('WASI: no memory bound');
    return this.memory.buffer;
  }

  view(): DataView {
    return new DataView(this.buffer());
  }

  bytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.buffer(), ptr, len);
  }

  string(ptr: number, len: number): string {
    return decoder.decode(this.bytes(ptr, len));
  }

  /** `[base, length]` of each of `count` iovecs at `ptr`. */
  iovecs(ptr: number, count: number): Array<[number, number]> {
    const v = this.view();
    const out: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
    }
    return out;
  }

  /** How many bytes the iovecs can take. */
  capacity(ptr: number, count: number): number {
    return this.iovecs(ptr, count).reduce((n, [, len]) => n + len, 0);
  }

  /** The iovecs' bytes, in one buffer of their own (a write's payload). */
  gather(ptr: number, count: number): Uint8Array {
    const vecs = this.iovecs(ptr, count);
    if (vecs.length === 1) return this.bytes(vecs[0][0], vecs[0][1]).slice();
    const out = new Uint8Array(vecs.reduce((n, [, len]) => n + len, 0));
    let at = 0;
    for (const [base, len] of vecs) {
      out.set(this.bytes(base, len), at);
      at += len;
    }
    return out;
  }

  /** Spread `data` over the iovecs; the bytes placed. */
  scatter(ptr: number, count: number, data: Uint8Array): number {
    let at = 0;
    for (const [base, len] of this.iovecs(ptr, count)) {
      if (at >= data.length) break;
      const n = Math.min(len, data.length - at);
      this.bytes(base, n).set(data.subarray(at, at + n));
      at += n;
    }
    return at;
  }

  /** NUL-terminated strings into `buf`, their addresses into `ptrs`. */
  putStrings(list: readonly string[], ptrs: number, buf: number): void {
    const encoder = new TextEncoder();
    const v = this.view();
    let at = buf;
    list.forEach((s, i) => {
      const b = encoder.encode(s);
      v.setUint32(ptrs + i * 4, at, true);
      this.bytes(at, b.length).set(b);
      v.setUint8(at + b.length, 0);
      at += b.length + 1;
    });
  }

  /** How many strings, and the bytes they take with their NULs. */
  putSizes(list: readonly string[], countPtr: number, sizePtr: number): void {
    const encoder = new TextEncoder();
    const v = this.view();
    v.setUint32(countPtr, list.length, true);
    v.setUint32(
      sizePtr,
      list.reduce((n, s) => n + encoder.encode(s).length + 1, 0),
      true
    );
  }
}
