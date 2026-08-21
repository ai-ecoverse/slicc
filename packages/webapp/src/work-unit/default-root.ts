/**
 * The **default root** — the cone an unaddressed event lands in (#2273).
 *
 * Before this, "default" meant `rootsOf(scoops)[0]`: the oldest root, with no
 * way for the user to say otherwise. With several cones behind the
 * `multiple-cones` flag that is a coin toss — a webhook, a cron tick or a
 * workflow completion went wherever the registry happened to sort first.
 *
 * The choice is now an explicit, persisted setting: a jid the user picks from
 * the Cones rail ("Make default"). Resolution is
 *
 *   configured root (when it is still a registered root)
 *     → the primary root (folder `cone`)
 *       → the oldest root.
 *
 * Storage is `localStorage`, the same substrate `shell/sprinkle-routes.ts`
 * uses for sprinkle routes, and for the same reason: the kernel worker gets a
 * Map-backed shim seeded at boot and kept live by `kernel/page-storage-sync.ts`,
 * so a panel-side write is visible to worker-side routing without any new
 * message plumbing. Every access is guarded — a worker booted without the shim,
 * or a browser with storage disabled, simply falls back to primary/oldest.
 */

import type { RegisteredScoop } from '../scoops/types.js';
import { rootsOf } from './policy.js';
import { PRIMARY_CONE_FOLDER } from './record.js';

/** `localStorage` key holding the user-selected default root's jid. */
export const DEFAULT_ROOT_STORAGE_KEY = 'slicc-default-root';

/** The configured default root's jid, or `null` when the user never picked one. */
export function getDefaultRootJid(): string | null {
  try {
    return localStorage.getItem(DEFAULT_ROOT_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Persist `jid` as the root unaddressed events land in. */
export function setDefaultRootJid(jid: string): void {
  try {
    localStorage.setItem(DEFAULT_ROOT_STORAGE_KEY, jid);
  } catch {
    /* storage disabled or full — routing falls back to primary/oldest */
  }
}

/** Forget the user's pick; resolution reverts to primary/oldest. */
export function clearDefaultRootJid(): void {
  try {
    localStorage.removeItem(DEFAULT_ROOT_STORAGE_KEY);
  } catch {
    /* storage disabled — nothing was stored either */
  }
}

/** Minimum a record needs for default-root resolution. */
type RootCandidate = Pick<RegisteredScoop, 'parentJid' | 'folder' | 'addedAt' | 'jid'>;

/**
 * The root an unaddressed event should reach: the configured one while it is
 * still registered as a root, else the primary cone, else the oldest root.
 *
 * `configuredJid` defaults to the persisted setting so call sites stay a
 * single expression; tests (and the panel, which already holds the value)
 * pass it explicitly.
 */
export function pickDefaultRoot<T extends RootCandidate>(
  scoops: Iterable<T>,
  configuredJid: string | null = getDefaultRootJid()
): T | undefined {
  const roots = rootsOf(scoops);
  if (configuredJid) {
    const chosen = roots.find((s) => s.jid === configuredJid);
    if (chosen) return chosen;
  }
  return roots.find((s) => s.folder === PRIMARY_CONE_FOLDER) ?? roots[0];
}
