/**
 * Create-time validation of an EXPLICIT `--scoop` value, shared by `webhook
 * create`, `crontask create` and `fswatch create` (issue #2524).
 *
 * Before this, a `--scoop` naming nothing was persisted as an active entry and
 * every delivery to it was dropped — while the HTTP caller was told `202`. The
 * runtime already treats such an entry as illegal: `LickManager.init` DELETES
 * licks whose target no longer resolves. Refusing the target at create time is
 * the same rule applied one step earlier, where the user can still fix the typo.
 *
 * Two rules keep this from becoming a new failure mode:
 *
 *  - **Only an explicit value is checked.** An omitted `--scoop` resolves
 *    through `defaultLickTarget` and is out of scope here (issue #2525).
 *  - **An unanswerable question is never an error.** No manager surface, a host
 *    that predates the op, or a proxy round-trip that fails all report
 *    `unverifiable`, and the target is accepted exactly as before.
 */

import type { LickManagerSurface } from './lick-surface.js';

/** How many valid targets a rejection lists before it truncates. */
const MAX_LISTED_CANDIDATES = 12;

function describeCandidates(candidates: string[]): string {
  if (candidates.length === 0) return 'no cones or scoops are registered';
  const listed = candidates.slice(0, MAX_LISTED_CANDIDATES);
  const suffix = candidates.length > listed.length ? ', …' : '';
  return `valid targets: ${listed.join(', ')}${suffix}`;
}

/**
 * Resolve `target` against the live roster. Returns the stderr line the caller
 * should print (already prefixed with the command name), or `null` when the
 * target is fine — or cannot be checked.
 */
export async function explicitLickTargetError(
  surface: Pick<LickManagerSurface, 'resolveLickTarget'> | null,
  command: string,
  target: string | undefined
): Promise<string | null> {
  if (!target || !surface) return null;
  let resolution: Awaited<ReturnType<LickManagerSurface['resolveLickTarget']>>;
  try {
    resolution = await surface.resolveLickTarget(target);
  } catch {
    // A dead proxy host / timed-out round trip is not evidence the target is
    // wrong, and rejecting on it would break creation whenever the bridge hiccups.
    return null;
  }
  if (resolution.status !== 'unresolved') return null;
  return (
    `${command}: --scoop "${target}" matches no live cone or scoop — ` +
    `its licks would be dropped (${describeCandidates(resolution.candidates)})\n`
  );
}
