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

    await setLastSeenVersion('2.0.0');
    expect(await reader?.()).toBe('2.0.0');
  });
});
