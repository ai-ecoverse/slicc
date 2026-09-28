import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IntegrityError, verifyTarballIntegrity } from '../../../src/shell/ipk/integrity.js';

const BYTES = new TextEncoder().encode('the published tarball');
const OTHER = new TextEncoder().encode('something else');

function sri(algo: string, data: Uint8Array): string {
  return `${algo}-${createHash(algo).update(data).digest('base64')}`;
}

function hexSha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

describe('verifyTarballIntegrity', () => {
  it('accepts bytes matching a sha512 dist.integrity', async () => {
    await expect(
      verifyTarballIntegrity(BYTES, { integrity: sri('sha512', BYTES) }, 'p@1.0.0')
    ).resolves.toBeUndefined();
  });

  it('rejects bytes that do not match dist.integrity, naming both digests', async () => {
    const expected = sri('sha512', BYTES);
    const err = await verifyTarballIntegrity(OTHER, { integrity: expected }, 'p@1.0.0').catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(IntegrityError);
    expect((err as IntegrityError).code).toBe('EINTEGRITY');
    expect((err as Error).message).toContain(`expected ${expected}`);
    expect((err as Error).message).toContain(`got ${sri('sha512', OTHER)}`);
  });

  it('does not fall back to a matching shasum when dist.integrity mismatches', async () => {
    await expect(
      verifyTarballIntegrity(
        OTHER,
        { integrity: sri('sha512', BYTES), shasum: hexSha1(OTHER) },
        'p@1.0.0'
      )
    ).rejects.toThrow(/does not match its dist\.integrity/);
  });

  it('checks only the strongest algorithm in a multi-hash SRI string', async () => {
    const weakMatches = `${sri('sha1', OTHER)} ${sri('sha512', BYTES)}`;
    await expect(verifyTarballIntegrity(OTHER, { integrity: weakMatches }, 'p')).rejects.toThrow(
      /EINTEGRITY/
    );
    await expect(
      verifyTarballIntegrity(BYTES, { integrity: weakMatches }, 'p')
    ).resolves.toBeUndefined();
  });

  it('accepts any of several hashes of the strongest algorithm and ignores SRI options', async () => {
    const integrity = `${sri('sha512', OTHER)} ${sri('sha512', BYTES)}?opt=1`;
    await expect(verifyTarballIntegrity(BYTES, { integrity }, 'p')).resolves.toBeUndefined();
  });

  it('supports sha384 and sha256 SRI strings', async () => {
    await expect(
      verifyTarballIntegrity(BYTES, { integrity: sri('sha384', BYTES) }, 'p')
    ).resolves.toBeUndefined();
    await expect(
      verifyTarballIntegrity(BYTES, { integrity: sri('sha256', BYTES) }, 'p')
    ).resolves.toBeUndefined();
  });

  it('falls back to the hex dist.shasum when there is no dist.integrity', async () => {
    await expect(
      verifyTarballIntegrity(BYTES, { shasum: hexSha1(BYTES).toUpperCase() }, 'p')
    ).resolves.toBeUndefined();
    await expect(
      verifyTarballIntegrity(OTHER, { shasum: hexSha1(BYTES) }, 'p@2.0.0')
    ).rejects.toThrow(/EINTEGRITY: p@2\.0\.0 does not match its dist\.shasum/);
  });

  it('falls back to dist.shasum when dist.integrity has no supported algorithm', async () => {
    await expect(
      verifyTarballIntegrity(BYTES, { integrity: 'md5-abc', shasum: hexSha1(BYTES) }, 'p')
    ).resolves.toBeUndefined();
  });

  it('fails closed on an unusable dist.integrity with no shasum', async () => {
    await expect(verifyTarballIntegrity(BYTES, { integrity: 'md5-abc' }, 'p')).rejects.toThrow(
      /no supported algorithm/
    );
  });

  it('fails closed when neither hash is present', async () => {
    await expect(verifyTarballIntegrity(BYTES, {}, 'p@1.0.0')).rejects.toThrow(
      /EINTEGRITY: p@1\.0\.0 has neither dist\.integrity nor dist\.shasum/
    );
    await expect(
      verifyTarballIntegrity(BYTES, { integrity: ' ', shasum: '' }, 'p')
    ).rejects.toThrow(/neither/);
  });

  it('hashes only the viewed bytes of a subarray', async () => {
    const backing = new Uint8Array(BYTES.length + 8);
    backing.set(BYTES, 4);
    const view = backing.subarray(4, 4 + BYTES.length);
    await expect(
      verifyTarballIntegrity(view, { integrity: sri('sha512', BYTES) }, 'p')
    ).resolves.toBeUndefined();
  });
});
