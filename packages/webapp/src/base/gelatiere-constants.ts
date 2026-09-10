/**
 * The gelatiere's identifiers, on their own so the boot-critical modules
 * that only need to RECOGNISE the unit (`scoop-context.ts`, the kernel host)
 * do not hoist the store module — and with it the bundled `GELATIERE.md`
 * prompt — into the worker's eager first-load graph.
 */

/** Storage folder of the gelatiere's unit — also its lick address. */
export const GELATIERE_FOLDER = 'gelatiere';
/** `sprinkleName` of every lick the gelatiere sends and receives. */
export const GELATIERE_SPRINKLE_NAME = 'gelatiere';
/** Name of the nightly crontask registered against the unit. */
export const GELATIERE_NIGHTLY_CRON_NAME = 'gelatiere-nightly';

/**
 * The gelatiere's `parentJid`. It is a CHILD unit — a scoop, read-only in the
 * UI, no composer — but no cone owns it, so its ownership edge points at this
 * synthetic owner that never exists in the roster. Every consumer of a
 * dangling edge already falls back to the default root (approvals, idle
 * notices, `tmpDirFor`), and cascades only follow real parents, so nothing
 * can drop it by dropping a cone.
 */
export const GELATIERE_OWNER_JID = 'system:gelatiere';

/** `true` for the gelatiere's own record: the child under the synthetic owner, in its folder. */
export function isGelatiereUnit(scoop: { parentJid: string | null; folder: string }): boolean {
  return scoop.parentJid === GELATIERE_OWNER_JID && scoop.folder === GELATIERE_FOLDER;
}
