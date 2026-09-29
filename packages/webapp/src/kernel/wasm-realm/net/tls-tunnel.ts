import { createLogger } from '../../../base/logger.js';
import type { KernelSocket } from '../socket.js';
import type { ByteSource, Incoming } from './http1.js';
import type { HttpSink, TunnelHandler, TunnelTarget } from './proxy-service.js';
import { LEAF_LIFETIME, type RealmCa } from './realm-ca.js';
import type { TlsEngine, TlsLeaf, TlsSession } from './tls-engine.js';

const log = createLogger('realm-tls');

const LEAF_REUSE = LEAF_LIFETIME - 24 * 60 * 60 * 1000;

const LEAF_CACHE = 256;
const CIPHER_READ = 64 * 1024;

export class TlsStream implements ByteSource, HttpSink {
  private pending: Uint8Array = new Uint8Array(0);
  private ended = false;

  constructor(
    private readonly session: TlsSession,
    private readonly cipherIn: ByteSource,
    private readonly cipherOut: KernelSocket
  ) {}

  private async flush(signal?: AbortSignal): Promise<void> {
    for (let out = this.session.take(); out.length > 0; out = this.session.take()) {
      await this.cipherOut.write(out, signal);
    }
  }

  private feedPending(): void {
    if (this.pending.length === 0) return;
    const n = this.session.feed(this.pending);
    this.pending = this.pending.subarray(n);
  }

  async read(_max: number, signal?: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      this.feedPending();
      const got = this.session.read();
      await this.flush(signal);
      if (got instanceof Uint8Array) return got;
      if (got === 'eof') return new Uint8Array(0);
      if (this.pending.length > 0) continue;
      if (this.ended) {
        this.session.feedEnd();
        const last = this.session.read();
        await this.flush(signal);
        return last instanceof Uint8Array ? last : new Uint8Array(0);
      }
      const cipher = await this.cipherIn.read(CIPHER_READ, signal);
      if (cipher.length === 0) this.ended = true;
      else this.pending = cipher;
    }
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    for (let at = 0; at < bytes.length; ) {
      const n = this.session.write(bytes.subarray(at, at + 16 * 1024));
      await this.flush(signal);
      at += n;
    }
    return bytes.length;
  }

  async close(signal?: AbortSignal): Promise<void> {
    this.session.close();
    await this.flush(signal);
  }
}

interface CachedLeaf {
  leaf: Promise<TlsLeaf>;
  expires: number;
}

export interface TlsTerminatorOptions {
  ca: () => Promise<RealmCa>;

  engine: () => Promise<TlsEngine>;
  now?: () => number;
}

export class TlsTerminator {
  private readonly leaves = new Map<string, CachedLeaf>();
  private readonly now: () => number;

  constructor(private readonly options: TlsTerminatorOptions) {
    this.now = options.now ?? Date.now;
  }

  private leafFor(engine: TlsEngine, host: string): Promise<TlsLeaf> {
    const now = this.now();
    const cached = this.leaves.get(host);
    if (cached && cached.expires > now) {
      this.leaves.delete(host);
      this.leaves.set(host, cached);
      return cached.leaf;
    }
    if (cached) void this.drop(host, cached);
    const leaf = this.issue(engine, host, now);
    const entry = { leaf, expires: now + LEAF_REUSE };
    this.leaves.set(host, entry);
    leaf.catch(() => {
      if (this.leaves.get(host) === entry) this.leaves.delete(host);
    });
    for (const [oldest, old] of this.leaves) {
      if (this.leaves.size <= LEAF_CACHE) break;
      void this.drop(oldest, old);
    }
    return leaf;
  }

  private async drop(host: string, entry: CachedLeaf): Promise<void> {
    if (this.leaves.get(host) === entry) this.leaves.delete(host);

    (await entry.leaf.catch(() => undefined))?.release();
  }

  private async issue(engine: TlsEngine, host: string, now: number): Promise<TlsLeaf> {
    const ca = await this.options.ca();
    const leaf = engine.leaf();
    try {
      leaf.addCert(await ca.issue(host, leaf.spki(), now));
      leaf.addCert(ca.cert);
      return leaf;
    } catch (e) {
      leaf.release();
      throw e;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.leaves].map(([host, entry]) => this.drop(host, entry)));
  }

  readonly handler: TunnelHandler = async (conn, incoming, target, signal, serveHttp) => {
    const engine = await this.options.engine();
    const host = target.host.replace(/^\[|\]$/g, '');
    const leaf = await this.leafFor(engine, host);
    const session = engine.session(leaf, host);
    try {
      const stream = new TlsStream(session, cipherSource(incoming), conn);
      const origin = `https://${authority(target)}`;
      try {
        await serveHttp(stream, stream, origin);
        await stream.close(signal).catch(() => undefined);
      } catch (e) {
        log.debug('tunnel ended', { host, error: String(e) });
        throw e;
      }
    } finally {
      session.free();
    }
  };
}

export function authority(target: TunnelTarget): string {
  return target.port === 443 ? target.host : `${target.host}:${target.port}`;
}

function cipherSource(incoming: Incoming): ByteSource {
  return { read: (max, signal) => incoming.some(max, signal) };
}
