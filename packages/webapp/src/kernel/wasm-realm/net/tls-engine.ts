/**
 * `tls-engine.ts` — the Mbed TLS engine (`@ai-ecoverse/wasm-tls-engine`, a
 * lazy chunk plus its wasm) behind a typed API: leaves (a key pair the
 * engine keeps, a chain the realm CA signed) and server sessions over memory
 * buffers. Every call is synchronous, so one scratch buffer serves them all.
 */
import type { TlsEngineModule } from '@ai-ecoverse/wasm-tls-engine';

const SCRATCH = 64 * 1024;
/** `tls_read`'s end of stream. */
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

  /** Copy `bytes` into the module (a fresh allocation the caller frees). */
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

  /** A new leaf key pair. */
  leaf(): TlsLeaf {
    const ptr = this.m._tls_leaf_new();
    if (!ptr) throw this.error(this.m._tls_last_error(), 'leaf key');
    return new TlsLeaf(this, this.m, ptr);
  }

  /** A server session for `host`, presenting `leaf`'s chain. */
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

  /** @internal */
  withBytes<T>(bytes: Uint8Array, fn: (ptr: number) => T): T {
    const ptr = this.put(bytes);
    try {
      return fn(ptr);
    } finally {
      this.m._free(ptr);
    }
  }

  /** @internal Run `fn` into the scratch buffer and copy out what it wrote. */
  intoScratch(fn: (ptr: number, max: number) => number): number | Uint8Array {
    const n = fn(this.scratch, SCRATCH);
    return n > 0 ? this.taken(n) : n;
  }
}

/** A key pair the engine holds and the chain the realm CA signed for it. */
export class TlsLeaf {
  constructor(
    private readonly engine: TlsEngine,
    private readonly m: TlsEngineModule,
    readonly ptr: number
  ) {}

  /** The public key (DER SubjectPublicKeyInfo): all of the pair that ever leaves the engine. */
  spki(): Uint8Array {
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_leaf_spki(this.ptr, ptr, max));
    if (typeof out === 'number') throw this.engine.error(out, 'leaf public key');
    return out;
  }

  /** Add a DER certificate to the chain: the leaf's own first, then its issuer. */
  addCert(der: Uint8Array): void {
    const ret = this.engine.withBytes(der, (ptr) =>
      this.m._tls_leaf_add_cert(this.ptr, ptr, der.length)
    );
    if (ret !== 0) throw this.engine.error(ret, 'leaf certificate');
  }

  /** Drop this reference; sessions keep the leaf until they are freed. */
  release(): void {
    this.m._tls_leaf_free(this.ptr);
  }
}

/** One server TLS session over memory buffers. */
export class TlsSession {
  constructor(
    private readonly engine: TlsEngine,
    private readonly m: TlsEngineModule,
    private readonly ptr: number
  ) {}

  /** Give ciphertext from the client; how many bytes were taken (the rest when there is room). */
  feed(bytes: Uint8Array): number {
    return this.engine.withBytes(bytes, (ptr) => this.m._tls_feed(this.ptr, ptr, bytes.length));
  }

  /** The client sent its last byte. */
  feedEnd(): void {
    this.m._tls_feed_eof(this.ptr);
  }

  /** Plaintext; `'more'` when more ciphertext is needed; `'eof'` when the client closed. */
  read(): Uint8Array | 'more' | 'eof' {
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_read(this.ptr, ptr, max));
    if (out instanceof Uint8Array) return out;
    if (out === 0) return 'more';
    if (out === EOF) return 'eof';
    throw this.engine.error(out, 'tls');
  }

  /** Encrypt plaintext: bytes taken (0: drain {@link take} and retry). */
  write(bytes: Uint8Array): number {
    const n = this.engine.withBytes(bytes, (ptr) => this.m._tls_write(this.ptr, ptr, bytes.length));
    if (n < 0) throw this.engine.error(n, 'tls');
    return n;
  }

  /** Ciphertext to send to the client (empty when none). */
  take(): Uint8Array {
    if (this.m._tls_out_size(this.ptr) === 0) return new Uint8Array(0);
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_out_take(this.ptr, ptr, max));
    return out instanceof Uint8Array ? out : new Uint8Array(0);
  }

  /** Queue close_notify (then {@link take}). */
  close(): void {
    this.m._tls_close(this.ptr);
  }

  /** 0x0303 (TLS 1.2) or 0x0304 (TLS 1.3). */
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

/** The engine, loaded once, on first use (a lazy chunk: never on the boot path). */
export function loadTlsEngine(
  load: () => Promise<TlsEngineModule> = async () =>
    (await import('@ai-ecoverse/wasm-tls-engine')).default()
): Promise<TlsEngine> {
  loading ??= load().then((m) => new TlsEngine(m));
  // A failed load is retried by the next caller.
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
