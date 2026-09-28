/**
 * `realm-ca.ts` — each wasm realm owner's certificate authority (#3571): the
 * root the realm's native programs trust, which issues the leaf the proxy
 * presents for each host it terminates TLS for.
 *
 * Key custody: the CA's private key is a WebCrypto ECDSA P-256 key generated
 * **non-extractable** in the kernel worker. No JavaScript, the kernel's
 * included, can read its bytes; `crypto.subtle` only signs with it. It is
 * persisted in IndexedDB (`slicc-realm-ca`), which keeps a `CryptoKey` a
 * `CryptoKey` (structured clone preserves non-extractability), outside the
 * VFS: no path reaches it, from the shell, a file tool or a realm program.
 * Only the public certificate is written to the VFS (for `SSL_CERT_FILE`).
 */
import { certificate, type DistinguishedName, pem, randomSerial } from './x509.js';

/** What the store keeps for an owner: the key, the certificate and its public key. */
export interface CaRecord {
  key: CryptoKey;
  cert: Uint8Array;
  spki: Uint8Array;
  notAfter: number;
  name: DistinguishedName;
}

export interface CaStore {
  get(owner: string): Promise<CaRecord | undefined>;
  put(owner: string, record: CaRecord): Promise<void>;
}

const DAY = 24 * 60 * 60 * 1000;
/** A CA lives ten years and is replaced once it has less than 30 days left. */
const CA_LIFETIME = 3650 * DAY;
const CA_RENEW_BEFORE = 30 * DAY;
/** A leaf lives a week (its clock starts an hour early, for skew). */
export const LEAF_LIFETIME = 7 * DAY;

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The CA store in IndexedDB: one record per owner key. */
export function indexedDbCaStore(dbName = 'slicc-realm-ca'): CaStore {
  let db: Promise<IDBDatabase> | undefined;
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('ca');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return db;
  };
  return {
    async get(owner) {
      const store = (await open()).transaction('ca').objectStore('ca');
      return (await request(store.get(owner))) as CaRecord | undefined;
    },
    async put(owner, record) {
      const tx = (await open()).transaction('ca', 'readwrite');
      tx.objectStore('ca').put(record, owner);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

/** Why a name gets no leaf: the proxy refuses the tunnel. */
export class LeafNameError extends Error {}

/** A DNS name or IPv4 address a certificate can name. */
export function validLeafName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i.test(label));
}

export class RealmCa {
  private constructor(private readonly record: CaRecord) {}

  /** The owner's CA: the stored one while it is valid, else a new one (stored). */
  static async open(owner: string, store: CaStore, now = Date.now()): Promise<RealmCa> {
    const stored = await store.get(owner).catch(() => undefined);
    if (stored && stored.notAfter - now > CA_RENEW_BEFORE) return new RealmCa(stored);
    const record = await RealmCa.create(owner, now);
    await store.put(owner, record);
    return new RealmCa(record);
  }

  private static async create(owner: string, now: number): Promise<CaRecord> {
    const pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    const name = { organization: 'SLICC', commonName: `SLICC realm CA ${owner} ${id}` };
    const notAfter = now + CA_LIFETIME;
    const cert = await certificate({
      serial: randomSerial(),
      issuer: name,
      subject: name,
      notBefore: new Date(now - DAY),
      notAfter: new Date(notAfter),
      spki,
      issuerSpki: spki,
      kind: { ca: true },
      sign: signer(pair.privateKey),
    });
    return { key: pair.privateKey, cert, spki, notAfter, name };
  }

  /** The CA certificate (DER). */
  get cert(): Uint8Array {
    return this.record.cert;
  }

  /** The CA certificate as PEM: what programs trust. */
  get pem(): string {
    return pem(this.record.cert);
  }

  /** A server leaf for `host` over the public key `spki` (DER), valid for {@link LEAF_LIFETIME}. */
  async issue(host: string, spki: Uint8Array, now = Date.now()): Promise<Uint8Array> {
    const name = host.toLowerCase();
    if (!validLeafName(name)) throw new LeafNameError(`no certificate for ${host}`);
    return certificate({
      serial: randomSerial(),
      issuer: this.record.name,
      subject: { commonName: name.length <= 64 ? name : 'SLICC realm leaf' },
      notBefore: new Date(now - 60 * 60 * 1000),
      notAfter: new Date(now + LEAF_LIFETIME),
      spki,
      issuerSpki: this.record.spki,
      kind: { ca: false, host: name },
      sign: signer(this.record.key),
    });
  }
}

function signer(key: CryptoKey) {
  return async (tbs: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign(SIGN, key, tbs as Uint8Array<ArrayBuffer>));
}

let defaultStore: CaStore | undefined;
/** Each owner's CA, opened once per kernel. */
const opened = new Map<string, Promise<RealmCa>>();

/** The CA of `owner` (an `ownerKey`), from the IndexedDB store unless `store` says otherwise. */
export function realmCa(owner: string, store?: CaStore): Promise<RealmCa> {
  let ca = opened.get(owner);
  if (!ca) {
    defaultStore ??= store ? undefined : indexedDbCaStore();
    ca = RealmCa.open(owner, store ?? (defaultStore as CaStore));
    opened.set(owner, ca);
    // A failure (no IndexedDB, say) is retried by the next caller.
    ca.catch(() => {
      if (opened.get(owner) === ca) opened.delete(owner);
    });
  }
  return ca;
}
