/**
 * Kernel-host wiring for the "last seen version" marker reader (#2228).
 *
 * `upgrade status` sits in the shell layer and cannot import the scoops-owned
 * marker reader, so the kernel host publishes one at boot. This pins that the
 * reader is actually registered and that it resolves the LIVE marker — an
 * earlier attempt mirrored the value into a worker-local `localStorage` shim
 * that nothing carried across a boot, so status could under-report a pending
 * merge while boot-time detection was still in flight.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getLastSeenVersionReader,
  setLastSeenVersionReader,
} from '../../src/base/slicc-version.js';
import { publishLastSeenVersionReader } from '../../src/kernel/host.js';
import { setLastSeenVersion } from '../../src/scoops/upgrade-detection.js';

describe('publishLastSeenVersionReader', () => {
  afterEach(() => {
    setLastSeenVersionReader(null);
  });

  it('registers a reader that resolves the recorded marker', async () => {
    expect(getLastSeenVersionReader()).toBeNull();

    publishLastSeenVersionReader();
    const reader = getLastSeenVersionReader();
    expect(reader).not.toBeNull();

    await setLastSeenVersion('1.2.3');
    expect(await reader?.()).toBe('1.2.3');
  });

  it('reads the marker live, so a mid-session advance is visible', async () => {
    publishLastSeenVersionReader();
    const reader = getLastSeenVersionReader();

    await setLastSeenVersion('1.0.0');
    expect(await reader?.()).toBe('1.0.0');

    // `recordVersionSeen` advances the marker after an upgrade lick is routed.
    await setLastSeenVersion('2.0.0');
    expect(await reader?.()).toBe('2.0.0');
  });
});
