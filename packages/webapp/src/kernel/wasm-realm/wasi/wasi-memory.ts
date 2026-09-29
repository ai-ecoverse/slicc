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
    return decoder.decode(this.bytes(ptr, len).slice());
  }

  cString(ptr: number): string {
    const bytes = new Uint8Array(this.buffer());
    let end = ptr;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return decoder.decode(bytes.slice(ptr, end));
  }

  size(): number {
    return this.buffer().byteLength;
  }

  iovecs(ptr: number, count: number): Array<[number, number]> {
    const v = this.view();
    const out: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
    }
    return out;
  }

  capacity(ptr: number, count: number): number {
    return this.iovecs(ptr, count).reduce((n, [, len]) => n + len, 0);
  }

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
