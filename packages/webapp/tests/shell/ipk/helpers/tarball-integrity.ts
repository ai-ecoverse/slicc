import { createHash } from 'node:crypto';

/**
 * Return a copy of `packument` whose versions carry the `dist.integrity`
 * (SRI sha512) and `dist.shasum` the npm registry would publish for the
 * tarball bytes in `tarballs`, keyed by tarball URL. ipk refuses tarballs it
 * cannot verify, so fake registries stamp these when they serve a packument.
 * Versions whose tarball is absent, or whose dist already has a hash, are
 * left alone.
 */
export function withTarballIntegrity<T>(packument: T, tarballs: Record<string, Uint8Array>): T {
  const pk = packument as { versions?: Record<string, { dist?: Record<string, unknown> }> };
  if (!pk || typeof pk !== 'object' || !pk.versions) return packument;
  const versions: Record<string, unknown> = {};
  for (const [version, entry] of Object.entries(pk.versions)) {
    const dist = entry?.dist;
    const bytes = typeof dist?.tarball === 'string' ? tarballs[dist.tarball] : undefined;
    if (!dist || !bytes || 'integrity' in dist || 'shasum' in dist) {
      versions[version] = entry;
      continue;
    }
    versions[version] = { ...entry, dist: { ...dist, ...tarballDigests(bytes) } };
  }
  return { ...pk, versions } as T;
}

/** The `dist.integrity` / `dist.shasum` pair npm publishes for `bytes`. */
export function tarballDigests(bytes: Uint8Array): { integrity: string; shasum: string } {
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}
