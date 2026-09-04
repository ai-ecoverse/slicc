/**
 * #2276 slice C, mounts domain: `fs/mount/capability-broker.ts`'s
 * module-level fact actually reaches `signed-fetch.ts`'s transports —
 * `setMountCapabilityBroker` isn't a no-op, and an unset broker fails
 * closed rather than silently defaulting to `node-rest` (round-1 review
 * finding 2: a composition miss on an extension topology must never POST a
 * signed envelope, IMS bearer included, to the hosted origin's REST routes).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getMountCapabilityBroker,
  setMountCapabilityBroker,
} from '../../../src/fs/mount/capability-broker.js';
import { makeSignedFetchS3 } from '../../../src/fs/mount/signed-fetch.js';
import {
  createConnectCapabilityBroker,
  createExtensionCapabilityBroker,
} from '../../../src/work-unit/capability/index.js';
import { createFakeCapabilityBroker } from '../../helpers/fake-capability-broker.js';

afterEach(() => {
  setMountCapabilityBroker(undefined);
});

describe('#2276 slice C — fs/mount/capability-broker.ts', () => {
  it('is unset (undefined) until something injects it — no silent node-rest guess', () => {
    expect(getMountCapabilityBroker()).toBeUndefined();
  });

  it('an unset broker makes signed-fetch.ts fail closed with an EIO naming setMountCapabilityBroker, not a POST anywhere', async () => {
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EIO',
      message: expect.stringContaining('setMountCapabilityBroker'),
    });
  });

  it('setMountCapabilityBroker makes getMountCapabilityBroker return the injected instance', () => {
    const injected = createFakeCapabilityBroker();
    setMountCapabilityBroker(injected);
    expect(getMountCapabilityBroker()).toBe(injected);
  });

  it('signed-fetch.ts transports actually call the injected broker', async () => {
    let seenBackend: string | undefined;
    const injected = createFakeCapabilityBroker({
      signRequest: (request) => {
        seenBackend = request.backend;
        return {
          ok: true,
          value: { ok: true, status: 200, headers: {}, bodyBase64: '' },
        };
      },
    });
    setMountCapabilityBroker(injected);

    const transport = makeSignedFetchS3('aws');
    const res = await transport({ method: 'GET', bucket: 'b', key: 'k' });

    expect(seenBackend).toBe('s3');
    expect(res.status).toBe(200);
  });

  it('a realm with extensionDelegateId set goes through the injected extension adapter, never /api/s3-sign-and-forward (round-1 review finding 5a)', async () => {
    let seenType: string | undefined;
    const extensionBroker = createExtensionCapabilityBroker({
      adapter: 'extension-delegate',
      callMount: async (type) => {
        seenType = type;
        return { ok: true, status: 200, headers: {}, bodyBase64: '' };
      },
    });
    setMountCapabilityBroker(extensionBroker);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('signed-fetch.ts must not call fetch() directly once a broker is injected');
    }) as typeof fetch;
    try {
      const transport = makeSignedFetchS3('aws');
      const res = await transport({ method: 'GET', bucket: 'b', key: 'k' });
      expect(seenType).toBe('mount.s3-sign-and-forward');
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('the connect adapter (no mounts surface at all) turns into FsError EIO, not an unhandled throw (round-1 review finding 5b)', async () => {
    setMountCapabilityBroker(createConnectCapabilityBroker());
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EIO',
    });
  });
});
