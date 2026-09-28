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
