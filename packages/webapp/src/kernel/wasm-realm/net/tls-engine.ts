import type { TlsEngineModule } from '@ai-ecoverse/wasm-tls-engine';

const SCRATCH = 64 * 1024;

const EOF = -1;

export class TlsError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

export class TlsEngine {
  private readonly scratch: number;

  constructor(private readonly m: TlsEngineModule) {
    this.scratch = m._malloc(SCRATCH);
    if (!this.scratch) throw new Error('tls engine: out of memory');
  }

  private put(bytes: Uint8Array): number {
    const ptr = this.m._malloc(bytes.length + 1);
    if (!ptr) throw new Error('tls engine: out of memory');
    this.m.HEAPU8.set(bytes, ptr);
    this.m.HEAPU8[ptr + bytes.length] = 0;
    return ptr;
  }

  private taken(n: number): Uint8Array {
    return this.m.HEAPU8.slice(this.scratch, this.scratch + n);
  }

  error(code: number, what: string): TlsError {
    this.m._tls_strerror(code, this.scratch, 256);
    const end = this.m.HEAPU8.indexOf(0, this.scratch);
    const text = new TextDecoder().decode(this.m.HEAPU8.subarray(this.scratch, end));
    return new TlsError(code, `${what}: ${text || code}`);
  }

  leaf(): TlsLeaf {
    const ptr = this.m._tls_leaf_new();
    if (!ptr) throw this.error(this.m._tls_last_error(), 'leaf key');
    return new TlsLeaf(this, this.m, ptr);
  }

  session(leaf: TlsLeaf, host: string): TlsSession {
    const name = this.put(new TextEncoder().encode(host));
    try {
      const ptr = this.m._tls_session_new(leaf.ptr, name);
      if (!ptr) throw this.error(this.m._tls_last_error(), 'tls session');
      return new TlsSession(this, this.m, ptr);
    } finally {
      this.m._free(name);
    }
  }

  withBytes<T>(bytes: Uint8Array, fn: (ptr: number) => T): T {
    const ptr = this.put(bytes);
    try {
      return fn(ptr);
    } finally {
      this.m._free(ptr);
    }
  }

  intoScratch(fn: (ptr: number, max: number) => number): number | Uint8Array {
    const n = fn(this.scratch, SCRATCH);
    return n > 0 ? this.taken(n) : n;
  }
}

export class TlsLeaf {
  constructor(
    private readonly engine: TlsEngine,
    private readonly m: TlsEngineModule,
    readonly ptr: number
  ) {}

  spki(): Uint8Array {
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_leaf_spki(this.ptr, ptr, max));
    if (typeof out === 'number') throw this.engine.error(out, 'leaf public key');
    return out;
  }

  addCert(der: Uint8Array): void {
    const ret = this.engine.withBytes(der, (ptr) =>
      this.m._tls_leaf_add_cert(this.ptr, ptr, der.length)
    );
    if (ret !== 0) throw this.engine.error(ret, 'leaf certificate');
  }

  release(): void {
    this.m._tls_leaf_free(this.ptr);
  }
}

export class TlsSession {
  constructor(
    private readonly engine: TlsEngine,
    private readonly m: TlsEngineModule,
    private readonly ptr: number
  ) {}

  feed(bytes: Uint8Array): number {
    return this.engine.withBytes(bytes, (ptr) => this.m._tls_feed(this.ptr, ptr, bytes.length));
  }

  feedEnd(): void {
    this.m._tls_feed_eof(this.ptr);
  }

  read(): Uint8Array | 'more' | 'eof' {
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_read(this.ptr, ptr, max));
    if (out instanceof Uint8Array) return out;
    if (out === 0) return 'more';
    if (out === EOF) return 'eof';
    throw this.engine.error(out, 'tls');
  }

  write(bytes: Uint8Array): number {
    const n = this.engine.withBytes(bytes, (ptr) => this.m._tls_write(this.ptr, ptr, bytes.length));
    if (n < 0) throw this.engine.error(n, 'tls');
    return n;
  }

  take(): Uint8Array {
    if (this.m._tls_out_size(this.ptr) === 0) return new Uint8Array(0);
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_out_take(this.ptr, ptr, max));
    return out instanceof Uint8Array ? out : new Uint8Array(0);
  }

  close(): void {
    this.m._tls_close(this.ptr);
  }

  get version(): number {
    return this.m._tls_version(this.ptr);
  }

  get handshakeDone(): boolean {
    return this.m._tls_handshake_done(this.ptr) !== 0;
  }

  free(): void {
    this.m._tls_session_free(this.ptr);
  }
}

let loading: Promise<TlsEngine> | undefined;

export function loadTlsEngine(
  load: () => Promise<TlsEngineModule> = async () =>
    (await import('@ai-ecoverse/wasm-tls-engine')).default()
): Promise<TlsEngine> {
  loading ??= load().then((m) => new TlsEngine(m));

  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
