/**
 * #2276 slice C, mounts domain: `fs/mount/capability-broker.ts`'s
 * module-level fact actually reaches `signed-fetch.ts`'s transports —
 * `setMountCapabilityBroker` isn't a no-op and the REST fallback only
 * applies when nothing was ever set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getMountCapabilityBroker,
  setMountCapabilityBroker,
} from '../../../src/fs/mount/capability-broker.js';
import { makeSignedFetchS3 } from '../../../src/fs/mount/signed-fetch.js';
import { createFakeCapabilityBroker } from '../../helpers/fake-capability-broker.js';

afterEach(() => {
  setMountCapabilityBroker(undefined);
});

describe('#2276 slice C — fs/mount/capability-broker.ts', () => {
  it('falls back to a node-rest broker when nothing was ever injected', () => {
    const broker = getMountCapabilityBroker();
    expect(broker.adapter).toBe('node-rest');
  });

  it('setMountCapabilityBroker makes getMountCapabilityBroker return the injected instance', () => {
    const injected = createFakeCapabilityBroker();
    setMountCapabilityBroker(injected);
    expect(getMountCapabilityBroker()).toBe(injected);
  });

  it('signed-fetch.ts transports actually call the injected broker, not a fresh REST one', async () => {
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
});
