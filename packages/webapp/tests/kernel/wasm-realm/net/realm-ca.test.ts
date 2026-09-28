import 'fake-indexeddb/auto';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CaRecord,
  type CaStore,
  indexedDbCaStore,
  LeafNameError,
  RealmCa,
  realmCa,
  validLeafName,
} from '../../../../src/kernel/wasm-realm/net/realm-ca.js';
import {
  children,
  integer,
  ipv4,
  oid,
  publicKeyBits,
} from '../../../../src/kernel/wasm-realm/net/x509.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function memoryStore(): CaStore & { records: Map<string, CaRecord> } {
  const records = new Map<string, CaRecord>();
  return {
    records,
    get: async (owner) => records.get(owner),
    put: async (owner, record) => {
      records.set(owner, record);
    },
  };
}

async function leafKey(): Promise<Uint8Array> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
}

describe('RealmCa', () => {
  it('creates a self-signed P-256 CA whose key cannot be exported, and keeps it', async () => {
    const store = memoryStore();
    const ca = await RealmCa.open('cone:', store);
    const cert = new X509Certificate(ca.pem);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toMatch(/^O=SLICC\nCN=SLICC realm CA cone: [0-9a-f]{8}$/);
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(new Date(cert.validTo).getTime() - Date.now()).toBeGreaterThan(9 * 365 * 86400_000);
    const record = store.records.get('cone:');
    expect(record?.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', record?.key as CryptoKey)).rejects.toThrow();
    // Opened again: the same CA.
    expect((await RealmCa.open('cone:', store)).pem).toBe(ca.pem);
  });

  it('replaces a CA with less than 30 days left', async () => {
    const store = memoryStore();
    const first = await RealmCa.open('scoop:a', store);
    const later = Date.now() + 3640 * 86400_000;
    const renewed = await RealmCa.open('scoop:a', store, later);
    expect(renewed.pem).not.toBe(first.pem);
  });

  it('issues a server leaf for a host, signed by the CA, with the SAN and usages TLS clients check', async () => {
    const ca = await RealmCa.open('cone:', memoryStore());
    const spki = await leafKey();
    const leaf = new X509Certificate(Buffer.from(await ca.issue('API.Example.com', spki)));
    const root = new X509Certificate(ca.pem);
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(leaf.checkIssued(root)).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.subjectAltName).toBe('DNS:api.example.com');
    expect(leaf.checkHost('api.example.com')).toBe('api.example.com');
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    const lifetime = new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime();
    expect(lifetime).toBe(7 * 86400_000 + 3600_000);
    expect(
      Buffer.from(leaf.publicKey.export({ type: 'spki', format: 'der' })).equals(Buffer.from(spki))
    ).toBe(true);

    const ip = new X509Certificate(Buffer.from(await ca.issue('10.1.2.3', spki)));
    expect(ip.subjectAltName).toBe('IP Address:10.1.2.3');
    expect(ip.checkIP('10.1.2.3')).toBe('10.1.2.3');
    const long = `${'a'.repeat(60)}.${'b'.repeat(60)}.test`;
    const longLeaf = new X509Certificate(Buffer.from(await ca.issue(long, spki)));
    expect(longLeaf.subject).toBe('CN=SLICC realm leaf');
    expect(longLeaf.checkHost(long)).toBe(long);
  });

  it('refuses names a certificate cannot carry', async () => {
    const ca = await RealmCa.open('cone:', memoryStore());
    await expect(ca.issue('bad_name.test', await leafKey())).rejects.toBeInstanceOf(LeafNameError);
    for (const bad of ['', '-a.test', 'a-.test', 'a..test', `${'x'.repeat(64)}.test`, 'a b']) {
      expect(validLeafName(bad)).toBe(false);
    }
    for (const good of ['a', 'example.com', 'xn--bcher-kva.example', '127.0.0.1']) {
      expect(validLeafName(good)).toBe(true);
    }
  });
});

describe('CA custody', () => {
  it('keeps the non-extractable key in IndexedDB, and each owner has its own CA', async () => {
    const store = indexedDbCaStore('slicc-realm-ca-test');
    const cone = await RealmCa.open('cone:', store);
    const scoop = await RealmCa.open('scoop:x', store);
    expect(scoop.pem).not.toBe(cone.pem);
    const stored = await store.get('cone:');
    expect(stored?.key).toBeInstanceOf(CryptoKey);
    expect(stored?.key.extractable).toBe(false);
    expect(hex(stored?.cert ?? new Uint8Array())).toBe(hex(cone.cert));
    // Signing still works through the stored key: a reopened CA issues verifiable leaves.
    const reopened = await RealmCa.open('cone:', indexedDbCaStore('slicc-realm-ca-test'));
    const leaf = new X509Certificate(Buffer.from(await reopened.issue('h.test', await leafKey())));
    expect(leaf.verify(new X509Certificate(cone.pem).publicKey)).toBe(true);
  });

  it('opens each owner once per kernel and retries after a failure', async () => {
    let fail = true;
    const store: CaStore = {
      get: async () => undefined,
      put: async () => {
        if (fail) throw new Error('quota');
      },
    };
    await expect(realmCa('scoop:retry', store)).rejects.toThrow('quota');
    fail = false;
    const ca = await realmCa('scoop:retry', store);
    expect(await realmCa('scoop:retry', store)).toBe(ca);
  });
});

describe('DER helpers', () => {
  it('encodes integers, OIDs and addresses', () => {
    expect(hex(integer(Uint8Array.of(0, 0, 0x80)))).toBe('02020080');
    expect(hex(integer(Uint8Array.of(0, 0)))).toBe('020100');
    expect(hex(oid('1.2.840.10045.4.3.2'))).toBe('06082a8648ce3d040302');
    expect(ipv4('1.2.3.4')).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(ipv4('1.2.3.400')).toBeUndefined();
    expect(ipv4('example.com')).toBeUndefined();
  });

  it('reads a public key out of a SubjectPublicKeyInfo', async () => {
    const spki = await leafKey();
    expect(children(spki)).toHaveLength(2);
    const bits = publicKeyBits(spki);
    expect(bits.length).toBe(65);
    expect(bits[0]).toBe(0x04);
  });
});
