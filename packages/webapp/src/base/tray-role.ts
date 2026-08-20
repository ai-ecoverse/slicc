/**
 * The runtime's tray role, read from the page→worker `localStorage` shims.
 *
 * The live status objects are scoops-owned (`scoops/tray-leader.ts`,
 * `scoops/tray-follower-status.ts`), and the shell sits below scoops in the
 * layer stack — so `uname -n` reads the same shim those modules' own
 * `…WithFallback` readers fall back to, rather than inverting the stack. The
 * storage keys live here so there is exactly one copy of each string; scoops
 * re-exports them under their established names.
 */

/**
 * Key for the page→worker `localStorage` shim mirroring the leader tray
 * status. `main.ts` writes it on every `subscribeToLeaderTrayRuntimeStatus`
 * tick; `installPageStorageSync` forwards page-side writes into the kernel
 * worker's Map-backed `localStorage` shim so worker readers see the same value.
 */
export const LEADER_STATUS_STORAGE_KEY = 'slicc.leaderTrayStatus';

/**
 * Key for the page→worker `localStorage` shim mirroring the follower tray
 * status. `wc-tray.ts` writes it on every `subscribeToFollowerTrayRuntimeStatus`
 * tick (and seeds it on boot). Symmetric with {@link LEADER_STATUS_STORAGE_KEY}.
 */
export const FOLLOWER_STATUS_STORAGE_KEY = 'slicc.followerTrayStatus';

export type TrayRole = 'leader' | 'follower' | 'standalone';

/** Read a mirrored tray status's `state`, or null when absent/unparseable. */
function shimState(key: string): string | null {
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(key);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { state?: unknown };
    return typeof parsed?.state === 'string' ? parsed.state : null;
  } catch {
    return null;
  }
}

/**
 * The runtime's role as a hostname-shaped single token, for `uname -n`.
 *
 * `follower` wins over `leader`: a runtime following someone else's tray is
 * never also leading one. A runtime in neither role — or one whose shims are
 * absent, as in a bare test realm — is `standalone`.
 */
export function readTrayRole(): TrayRole {
  const follower = shimState(FOLLOWER_STATUS_STORAGE_KEY);
  if (follower !== null && follower !== 'inactive') return 'follower';
  return shimState(LEADER_STATUS_STORAGE_KEY) === 'leader' ? 'leader' : 'standalone';
}
