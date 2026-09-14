import { readSliccVersion } from '../base/slicc-version.js';
import { getState, setState } from './db.js';

const LAST_SEEN_STATE_KEY = 'slicc:last-seen-version';

export interface BundledVersion {
  version: string;
  releasedAt: string | null;
}

export interface UpgradeDetection {
  bundled: BundledVersion;

  lastSeen: string | null;

  isUpgrade: boolean;
}

export function readBundledVersion(): BundledVersion {
  const { version, releasedAt } = readSliccVersion();
  return { version, releasedAt };
}

export async function getLastSeenVersion(): Promise<string | null> {
  const raw = await getState(LAST_SEEN_STATE_KEY);

  return raw && raw.length > 0 ? raw : null;
}

export async function setLastSeenVersion(version: string): Promise<void> {
  await setState(LAST_SEEN_STATE_KEY, version);
}

export async function detectUpgrade(): Promise<UpgradeDetection> {
  const bundled = readBundledVersion();
  const lastSeen = await getLastSeenVersion();

  if (lastSeen === null) {
    await setLastSeenVersion(bundled.version);
    return { bundled, lastSeen: null, isUpgrade: false };
  }

  if (lastSeen === bundled.version) {
    return { bundled, lastSeen, isUpgrade: false };
  }

  return { bundled, lastSeen, isUpgrade: true };
}

export async function recordVersionSeen(version: string): Promise<void> {
  await setLastSeenVersion(version);
}

export const __test__ = {
  LAST_SEEN_STATE_KEY,
};
