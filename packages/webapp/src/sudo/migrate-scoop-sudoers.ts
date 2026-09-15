/**
 * One-time cleanup of a pre-#3106 in-sandbox per-scoop sudoers file.
 *
 * Until #3106 a scoop's approved "Always" grants lived at
 * `/scoops/<folder>/etc/sudoers` — inside the very sandbox they governed, so a
 * single approved write let a scoop author its own authority. Policy now comes
 * from `/etc` only, and that path is refused outright (`matchPath` → `'deny'`).
 *
 * The legacy file has no trustworthy provenance: the prompt showed a path, not
 * contents, so a scoop (or an allow-once on that path) could omit the generated
 * header and leave `NOPASSWD Cmnd *` behind. Copying those rules into the
 * cone-owned drop-in would permanently preserve the escalation this change
 * closes. Fail-closed: delete the inert file; legitimate Always grants
 * re-prompt once through `appendScoopRule`.
 *
 * Split out of `sudo-manager.ts` — which is boot-critical and therefore sits in
 * the kernel worker's eager first-load closure — so this runs only on the
 * profiles that still have such a file. `SudoManager.initScoopPolicy` probes
 * for the file with a cheap `exists()` and dynamic-imports this module only on
 * a hit, the same reason `/etc/APPROVALS.md`'s bundled default is imported
 * lazily.
 */

import { createLogger } from '../base/logger.js';
import { legacyScoopSudoersPath } from '../base/sudoers.js';
import type { VirtualFS } from '../fs/index.js';

const log = createLogger('sudo:migrate');

/** Dependencies for {@link migrateLegacyScoopSudoers}. */
export interface MigrateScoopSudoersDeps {
  /** RAW VFS handle — bypasses the gate so the cleanup cannot be refused. */
  fs: VirtualFS;
}

/**
 * Delete `folder`'s legacy in-sandbox sudoers file without promoting its rules.
 * Idempotent: a second boot finds nothing to do once the source is gone.
 *
 * A delete failure leaves the file in place. That is inert, not dangerous —
 * nothing reads policy from it any more — and it keeps the content recoverable
 * for manual inspection instead of destroying it mid-cleanup.
 */
export async function migrateLegacyScoopSudoers(
  folder: string,
  deps: MigrateScoopSudoersDeps
): Promise<void> {
  const { fs } = deps;
  const legacyPath = legacyScoopSudoersPath(folder);
  try {
    if (!(await fs.exists(legacyPath))) return;
  } catch (err) {
    log.warn('Failed to probe legacy per-scoop sudoers; leaving in place', {
      folder,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  try {
    await fs.rm(legacyPath, { recursive: false });
    log.info('Discarded untrusted legacy in-sandbox per-scoop sudoers', {
      folder,
      path: legacyPath,
    });
  } catch (err) {
    log.warn('Failed to remove legacy per-scoop sudoers; left in place (inert)', {
      folder,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
