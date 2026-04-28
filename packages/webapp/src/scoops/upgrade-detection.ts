/**
 * Upgrade detection — compares the bundled SLICC version (baked into
 * `/shared/version.json` at release time via `sync-release-version.ts`)
 * against the version recorded in IndexedDB during the previous boot.
 *
 * On version change, the caller (ui/main.ts) emits an `upgrade` lick to
 * the cone. The upgrade skill can then surface a changelog and offer a
 * three-way merge of bundled vfs-root content into the user's workspace.
 *
 * The dev placeholder `0.0.0-dev` is treated as "no real release", so
 * we never fire upgrade licks during local development.
 */

import { createLogger } from '../core/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { getState, setState } from './db.js';

const log = createLogger('upgrade-detection');

const VERSION_FILE_PATH = '/shared/version.json';
const LAST_SEEN_STATE_KEY = 'slicc:last-seen-version';
const DEV_VERSION = '0.0.0-dev';

export interface BundledVersion {
  version: string;
  releasedAt: string | null;
}

export interface UpgradeDetection {
  bundled: BundledVersion;
  /** null on first boot; previously recorded version otherwise. */
  lastSeen: string | null;
  /** True when bundled.version differs from lastSeen and is a real release. */
  isUpgrade: boolean;
}

/**
 * Read the bundled SLICC version from `/shared/version.json`. Returns the
 * dev placeholder if the file is missing or malformed — callers should
 * treat that as "do not emit an upgrade lick".
 */
export async function readBundledVersion(fs: VirtualFS): Promise<BundledVersion> {
  try {
    const raw = await fs.readFile(VERSION_FILE_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text) as Partial<BundledVersion>;
    const version = typeof parsed.version === 'string' ? parsed.version : DEV_VERSION;
    const releasedAt = typeof parsed.releasedAt === 'string' ? parsed.releasedAt : null;
    return { version, releasedAt };
  } catch (err) {
    log.warn('Failed to read bundled version file', {
      path: VERSION_FILE_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    return { version: DEV_VERSION, releasedAt: null };
  }
}

export async function getLastSeenVersion(): Promise<string | null> {
  const raw = await getState(LAST_SEEN_STATE_KEY);
  // Treat both nullish and empty-string as "no recorded version" so the
  // marker can be cleared by writing an empty string in tests/dev tools.
  return raw && raw.length > 0 ? raw : null;
}

export async function setLastSeenVersion(version: string): Promise<void> {
  await setState(LAST_SEEN_STATE_KEY, version);
}

/**
 * Detect upgrades against the previously-stored "last seen" version and
 * advance the marker. Returns a structured result so the caller can
 * decide whether to emit a lick.
 *
 * Behavior matrix:
 *   - bundled is the dev placeholder → never an upgrade; do not record.
 *   - lastSeen is null (first boot) → record bundled, do not fire lick.
 *   - lastSeen === bundled → no change, no lick.
 *   - lastSeen !== bundled → upgrade, record new value, fire lick.
 */
export async function detectUpgrade(fs: VirtualFS): Promise<UpgradeDetection> {
  const bundled = await readBundledVersion(fs);
  const lastSeen = await getLastSeenVersion();

  if (bundled.version === DEV_VERSION) {
    // Dev build — never trigger upgrade licks. Leave the recorded version
    // alone so a subsequent real release still detects the bump.
    return { bundled, lastSeen, isUpgrade: false };
  }

  if (lastSeen === null) {
    // First boot on a real release — record silently.
    await setLastSeenVersion(bundled.version);
    return { bundled, lastSeen: null, isUpgrade: false };
  }

  if (lastSeen === bundled.version) {
    return { bundled, lastSeen, isUpgrade: false };
  }

  // Genuine upgrade — advance the marker and let the caller fire the lick.
  await setLastSeenVersion(bundled.version);
  return { bundled, lastSeen, isUpgrade: true };
}

export const __test__ = {
  VERSION_FILE_PATH,
  LAST_SEEN_STATE_KEY,
  DEV_VERSION,
};
