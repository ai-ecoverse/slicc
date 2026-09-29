import { certificate, type DistinguishedName, ipv6, pem, randomSerial } from './x509.js';

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

const CA_LIFETIME = 3650 * DAY;
const CA_RENEW_BEFORE = 30 * DAY;

export const LEAF_LIFETIME = 7 * DAY;

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function indexedDbCaStore(dbName = 'slicc-realm-ca'): CaStore {
  let db: Promise<IDBDatabase> | undefined;
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('ca');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    db.catch(() => {
      db = undefined;
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

export class LeafNameError extends Error {}

export function validLeafName(host: string): boolean {
  if (ipv6(host)) return true;
  if (host.length === 0 || host.length > 253) return false;
  return host.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i.test(label));
}

export class RealmCa {
  private constructor(private readonly record: CaRecord) {}

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

  get cert(): Uint8Array {
    return this.record.cert;
  }

  get pem(): string {
    return pem(this.record.cert);
  }

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

const opened = new Map<string, Promise<RealmCa>>();

export function realmCa(owner: string, store?: CaStore): Promise<RealmCa> {
  let ca = opened.get(owner);
  if (!ca) {
    defaultStore ??= store ? undefined : indexedDbCaStore();
    ca = RealmCa.open(owner, store ?? (defaultStore as CaStore));
    opened.set(owner, ca);

    ca.catch(() => {
      if (opened.get(owner) === ca) opened.delete(owner);
    });
  }
  return ca;
}
