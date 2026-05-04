/**
 * Tests for the upgrade-detection helper used by the boot-time `upgrade`
 * lick. The bundled SLICC version is injected at build time as
 * `__SLICC_VERSION__` (sourced from root package.json) and compared
 * against an IndexedDB-backed marker for the previously-seen version.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  detectUpgrade,
  getLastSeenVersion,
  setLastSeenVersion,
  readBundledVersion,
  recordVersionSeen,
} from '../../src/scoops/upgrade-detection.js';
import { setState } from '../../src/scoops/db.js';
import { __test__ } from '../../src/scoops/upgrade-detection.js';

describe('upgrade-detection', () => {
  beforeEach(async () => {
    // Reset the IndexedDB-backed marker between runs so the global
    // STATE store doesn't leak between tests in the same process.
    await setState(__test__.LAST_SEEN_STATE_KEY, '');
  });

  describe('readBundledVersion', () => {
    it('returns the build-time injected version and releasedAt', () => {
      const result = readBundledVersion();
      expect(result.version).toBe(__SLICC_VERSION__);
      expect(result.releasedAt).toBe(__SLICC_RELEASED_AT__);
    });
  });

  describe('detectUpgrade', () => {
    it('records the bundled version silently on first boot (no upgrade)', async () => {
      const result = await detectUpgrade();
      expect(result.isUpgrade).toBe(false);
      expect(result.lastSeen).toBeNull();
      expect(await getLastSeenVersion()).toBe(__SLICC_VERSION__);
    });

    it('does nothing when the bundled version matches the last-seen one', async () => {
      await setLastSeenVersion(__SLICC_VERSION__);
      const result = await detectUpgrade();
      expect(result.isUpgrade).toBe(false);
      expect(result.lastSeen).toBe(__SLICC_VERSION__);
      expect(await getLastSeenVersion()).toBe(__SLICC_VERSION__);
    });

    it('reports an upgrade WITHOUT advancing the marker so the caller can defer it until the lick is routed', async () => {
      await setLastSeenVersion('0.0.0-old');
      const result = await detectUpgrade();
      expect(result.isUpgrade).toBe(true);
      expect(result.lastSeen).toBe('0.0.0-old');
      expect(result.bundled.version).toBe(__SLICC_VERSION__);
      // Marker is intentionally NOT advanced here — caller controls
      // when to record so we don't lose the lick on transient no-cone
      // boots (extension fresh-install, deleted-cone reload, etc.).
      expect(await getLastSeenVersion()).toBe('0.0.0-old');
    });
  });

  describe('recordVersionSeen', () => {
    it('advances the last-seen marker (used by callers after routing the upgrade lick)', async () => {
      await setLastSeenVersion('0.0.0-old');
      const detected = await detectUpgrade();
      expect(detected.isUpgrade).toBe(true);
      // Marker is unchanged immediately after detection…
      expect(await getLastSeenVersion()).toBe('0.0.0-old');
      // …and only advances once the caller acknowledges the route.
      await recordVersionSeen(detected.bundled.version);
      expect(await getLastSeenVersion()).toBe(__SLICC_VERSION__);
    });

    it('is a no-op when called repeatedly with the same version', async () => {
      await recordVersionSeen('3.0.0');
      await recordVersionSeen('3.0.0');
      expect(await getLastSeenVersion()).toBe('3.0.0');
    });
  });
});
