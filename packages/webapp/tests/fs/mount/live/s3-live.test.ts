import 'fake-indexeddb/auto';
import { it, expect, beforeAll } from 'vitest';
import { S3MountBackend } from '../../../../src/fs/mount/backend-s3.js';
import { RemoteMountCache } from '../../../../src/fs/mount/remote-cache.js';
import type { S3Profile } from '../../../../src/fs/mount/profile.js';
import { liveDescribe } from './live.config.js';

/**
 * Live S3 round-trip. Hits the real bucket configured via env vars.
 *
 * Required env:
 *   SLICC_TEST_S3_BUCKET            — disposable test bucket
 *   SLICC_TEST_S3_ACCESS_KEY_ID
 *   SLICC_TEST_S3_SECRET_ACCESS_KEY
 *   SLICC_TEST_S3_REGION            (default 'us-east-1')
 *   SLICC_TEST_S3_ENDPOINT          (optional — set for R2 / S3-compatible)
 */
liveDescribe('S3 live round-trip', () => {
  let profile: S3Profile;
  let bucket: string;
  let prefix: string;

  beforeAll(() => {
    bucket = process.env['SLICC_TEST_S3_BUCKET'] ?? '';
    if (!bucket) throw new Error('SLICC_TEST_S3_BUCKET is required for live tests');
    profile = {
      accessKeyId: process.env['SLICC_TEST_S3_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: process.env['SLICC_TEST_S3_SECRET_ACCESS_KEY'] ?? '',
      region: process.env['SLICC_TEST_S3_REGION'] ?? 'us-east-1',
      endpoint: process.env['SLICC_TEST_S3_ENDPOINT'],
    };
    prefix = `slicc-live-test/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it('writes a file, reads it back, and deletes it', async () => {
    const backend = new S3MountBackend({
      source: `s3://${bucket}/${prefix}`,
      profile: 'live-test',
      profileResolved: profile,
      cache: new RemoteMountCache({ mountId: `live-${Date.now()}`, ttlMs: 30_000 }),
    });

    const body = new TextEncoder().encode(`hello ${new Date().toISOString()}`);
    await backend.writeFile('roundtrip.txt', body);

    const fetched = await backend.readFile('roundtrip.txt');
    expect(new TextDecoder().decode(fetched)).toBe(new TextDecoder().decode(body));

    await backend.remove('roundtrip.txt');
    await backend.close();
  });
});
