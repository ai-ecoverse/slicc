import 'fake-indexeddb/auto';
import { it, expect, beforeAll } from 'vitest';
import { DaMountBackend } from '../../../../src/fs/mount/backend-da.js';
import { RemoteMountCache } from '../../../../src/fs/mount/remote-cache.js';
import type { DaProfile } from '../../../../src/fs/mount/profile.js';
import { liveDescribe } from './live.config.js';

/**
 * Live DA round-trip. Hits admin.da.live with the configured IMS bearer.
 *
 * Required env:
 *   SLICC_TEST_DA_ORG    — org name
 *   SLICC_TEST_DA_REPO   — disposable repo for round-trip
 *   SLICC_TEST_DA_TOKEN  — IMS bearer token
 */
liveDescribe('DA live round-trip', () => {
  let profile: DaProfile;
  let org: string;
  let repo: string;
  let prefix: string;

  beforeAll(() => {
    org = process.env['SLICC_TEST_DA_ORG'] ?? '';
    repo = process.env['SLICC_TEST_DA_REPO'] ?? '';
    if (!org || !repo) {
      throw new Error('SLICC_TEST_DA_ORG and SLICC_TEST_DA_REPO are required for live DA tests');
    }
    const token = process.env['SLICC_TEST_DA_TOKEN'] ?? '';
    profile = {
      identity: 'live-test',
      getBearerToken: async () => token,
    };
    prefix = `slicc-live-test/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it('writes a file, reads it back, and deletes it', async () => {
    const backend = new DaMountBackend({
      source: `da://${org}/${repo}/${prefix}`,
      profile: 'live-test',
      profileResolved: profile,
      cache: new RemoteMountCache({ mountId: `live-da-${Date.now()}`, ttlMs: 30_000 }),
    });

    const body = new TextEncoder().encode(`<p>hello ${new Date().toISOString()}</p>`);
    await backend.writeFile('roundtrip.html', body);

    const fetched = await backend.readFile('roundtrip.html');
    expect(new TextDecoder().decode(fetched)).toBe(new TextDecoder().decode(body));

    await backend.remove('roundtrip.html');
    await backend.close();
  });
});
