/**
 * Tests for the upgrade-detection helper used by the boot-time `upgrade`
 * lick. Mirrors the bundled `/shared/version.json` produced at release
 * time and the IndexedDB-backed marker for the previously-seen version.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  detectUpgrade,
  getLastSeenVersion,
  setLastSeenVersion,
  readBundledVersion,
} from '../../src/scoops/upgrade-detection.js';
import { setState } from '../../src/scoops/db.js';
import { __test__ } from '../../src/scoops/upgrade-detection.js';

const VERSION_PATH = '/shared/version.json';

async function writeVersionFile(
  vfs: VirtualFS,
  payload: { version: string; releasedAt?: string | null }
): Promise<void> {
  await vfs.mkdir('/shared', { recursive: true });
  await vfs.writeFile(
    VERSION_PATH,
    `${JSON.stringify({ releasedAt: null, ...payload }, null, 2)}\n`
  );
}

describe('upgrade-detection', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-upgrade-${dbCounter++}`, wipe: true });
    // Reset the IndexedDB-backed marker between runs so the global
    // STATE store doesn't leak between tests in the same process.
    await setState(__test__.LAST_SEEN_STATE_KEY, '');
  });

  describe('readBundledVersion', () => {
    it('returns the parsed version when /shared/version.json exists', async () => {
      await writeVersionFile(vfs, { version: '1.2.3', releasedAt: '2026-04-01T00:00:00Z' });
      const result = await readBundledVersion(vfs);
      expect(result).toEqual({ version: '1.2.3', releasedAt: '2026-04-01T00:00:00Z' });
    });

    it('falls back to the dev placeholder when the file is missing', async () => {
      const result = await readBundledVersion(vfs);
      expect(result.version).toBe(__test__.DEV_VERSION);
      expect(result.releasedAt).toBeNull();
    });

    it('falls back to the dev placeholder when the file is malformed', async () => {
      await vfs.mkdir('/shared', { recursive: true });
      await vfs.writeFile(VERSION_PATH, 'not-json');
      const result = await readBundledVersion(vfs);
      expect(result.version).toBe(__test__.DEV_VERSION);
    });
  });

  describe('detectUpgrade', () => {
    it('records the bundled version silently on first boot (no upgrade)', async () => {
      await writeVersionFile(vfs, { version: '1.0.0' });
      const result = await detectUpgrade(vfs);
      expect(result.isUpgrade).toBe(false);
      expect(result.lastSeen).toBeNull();
      expect(await getLastSeenVersion()).toBe('1.0.0');
    });

    it('does nothing when the bundled version matches the last-seen one', async () => {
      await writeVersionFile(vfs, { version: '1.0.0' });
      await setLastSeenVersion('1.0.0');
      const result = await detectUpgrade(vfs);
      expect(result.isUpgrade).toBe(false);
      expect(result.lastSeen).toBe('1.0.0');
      expect(await getLastSeenVersion()).toBe('1.0.0');
    });

    it('reports an upgrade and advances the marker when the bundled version bumped', async () => {
      await writeVersionFile(vfs, {
        version: '1.1.0',
        releasedAt: '2026-04-15T00:00:00Z',
      });
      await setLastSeenVersion('1.0.0');
      const result = await detectUpgrade(vfs);
      expect(result.isUpgrade).toBe(true);
      expect(result.lastSeen).toBe('1.0.0');
      expect(result.bundled.version).toBe('1.1.0');
      expect(result.bundled.releasedAt).toBe('2026-04-15T00:00:00Z');
      expect(await getLastSeenVersion()).toBe('1.1.0');
    });

    it('never fires on dev builds (and does not record the placeholder)', async () => {
      await writeVersionFile(vfs, { version: __test__.DEV_VERSION });
      await setLastSeenVersion('1.0.0');
      const result = await detectUpgrade(vfs);
      expect(result.isUpgrade).toBe(false);
      // The marker was not advanced — a real release will still detect the bump.
      expect(await getLastSeenVersion()).toBe('1.0.0');
    });

    it('records the bundled version on first boot of a dev build', async () => {
      // Dev build, no last-seen yet → still no lick, but also no marker
      // (so the first real release a dev encounters is treated as first-boot).
      await writeVersionFile(vfs, { version: __test__.DEV_VERSION });
      const result = await detectUpgrade(vfs);
      expect(result.isUpgrade).toBe(false);
      expect(result.lastSeen).toBeNull();
      // We deliberately do not write the placeholder.
      expect(await getLastSeenVersion()).toBeNull();
    });
  });
});
