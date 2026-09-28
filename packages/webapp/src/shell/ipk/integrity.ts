/**
 * Tarball integrity checks for ipk (Ice Pack).
 *
 * Every tarball is checked against its packument's `dist.integrity` (a
 * Subresource Integrity string, normally `sha512-…`) before anything is
 * extracted, falling back to the legacy hex `dist.shasum` (SHA-1) when the
 * packument has no usable SRI hash. Like ssri, only the strongest algorithm
 * present is checked, and any hash of that algorithm may match.
 *
 * This fails closed: a mismatch, an SRI string with no supported algorithm
 * and no `dist.shasum` to fall back to, and a packument carrying neither field
 * all reject with `EINTEGRITY`. The
 * npm registry publishes both fields for every version, so a missing hash
 * means something between the registry and ipk rewrote the metadata.
 * Digests use WebCrypto, which exists in every float's worker realm.
 */

export interface TarballDigests {
  integrity?: string;
  shasum?: string;
}

const SRI_ALGORITHMS = {
  sha512: 'SHA-512',
  sha384: 'SHA-384',
  sha256: 'SHA-256',
  sha1: 'SHA-1',
} as const;

type SriAlgorithm = keyof typeof SRI_ALGORITHMS;

/** Strongest first, as ssri's `pickAlgorithm` orders them. */
const STRENGTH: SriAlgorithm[] = ['sha512', 'sha384', 'sha256', 'sha1'];

export class IntegrityError extends Error {
  readonly code = 'EINTEGRITY';
  constructor(message: string) {
    super(`EINTEGRITY: ${message}`);
    this.name = 'IntegrityError';
  }
}

function isSriAlgorithm(algo: string): algo is SriAlgorithm {
  return Object.prototype.hasOwnProperty.call(SRI_ALGORITHMS, algo);
}

/** Supported hashes in an SRI string, grouped by algorithm. Options (`?…`) are dropped. */
function parseSri(integrity: string): Map<SriAlgorithm, string[]> {
  const hashes = new Map<SriAlgorithm, string[]>();
  for (const token of integrity.trim().split(/\s+/)) {
    const dash = token.indexOf('-');
    if (dash <= 0) continue;
    const algo = token.slice(0, dash).toLowerCase();
    const digest = token.slice(dash + 1).split('?')[0];
    if (!digest || !isSriAlgorithm(algo)) continue;
    const list = hashes.get(algo) ?? [];
    list.push(digest);
    hashes.set(algo, list);
  }
  return hashes;
}

async function digest(algo: SriAlgorithm, bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer: `bytes` may be a view over a larger or shared buffer.
  const buf = await crypto.subtle.digest(SRI_ALGORITHMS[algo], bytes.slice());
  return new Uint8Array(buf);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Resolve when `bytes` match `expected`; reject with an {@link IntegrityError}
 * naming `label` otherwise. See the module comment for the rules.
 */
export async function verifyTarballIntegrity(
  bytes: Uint8Array,
  expected: TarballDigests,
  label: string
): Promise<void> {
  const integrity = typeof expected.integrity === 'string' ? expected.integrity.trim() : '';
  const shasum = typeof expected.shasum === 'string' ? expected.shasum.trim().toLowerCase() : '';

  if (integrity) {
    const hashes = parseSri(integrity);
    const algo = STRENGTH.find((a) => hashes.has(a));
    if (algo) {
      const actual = toBase64(await digest(algo, bytes));
      if (hashes.get(algo)?.includes(actual)) return;
      throw new IntegrityError(
        `${label} does not match its dist.integrity (expected ${integrity}, got ${algo}-${actual})`
      );
    }
    if (!shasum) {
      throw new IntegrityError(
        `${label} has a dist.integrity with no supported algorithm (${integrity})`
      );
    }
  }

  if (shasum) {
    const actual = toHex(await digest('sha1', bytes));
    if (actual === shasum) return;
    throw new IntegrityError(
      `${label} does not match its dist.shasum (expected ${shasum}, got ${actual})`
    );
  }

  throw new IntegrityError(
    `${label} has neither dist.integrity nor dist.shasum in the packument; refusing to install an unverifiable tarball`
  );
}
