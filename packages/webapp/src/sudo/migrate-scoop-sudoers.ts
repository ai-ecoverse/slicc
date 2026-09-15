/**
 * One-time migration of a pre-#3106 in-sandbox per-scoop sudoers file.
 *
 * Until #3106 a scoop's approved "Always" grants lived at
 * `/scoops/<folder>/etc/sudoers` — inside the very sandbox they governed, so a
 * single approved write let a scoop author its own authority. Policy now comes
 * from `/etc` only, and that path is refused outright (`matchPath` → `'deny'`).
 * A file already sitting there still holds grants the owner approved, so it is
 * moved to `/etc/sudoers.d/scoop-<folder>` and removed rather than silently
 * dropped.
 *
 * Split out of `sudo-manager.ts` — which is boot-critical and therefore sits in
 * the kernel worker's eager first-load closure — so this runs only on the
 * profiles that still have such a file. `SudoManager.initScoopPolicy` probes
 * for the file with a cheap `exists()` and dynamic-imports this module only on
 * a hit, the same reason `/etc/APPROVALS.md`'s bundled default is imported
 * lazily.
 */

import { createLogger } from '../base/logger.js';
import { legacyScoopSudoersPath, SUDOERS_D_DIR } from '../base/sudoers.js';
import type { VirtualFS } from '../fs/index.js';

const log = createLogger('sudo:migrate');

/**
 * First line of the LEGACY generated per-scoop format (pre-#2416). Those files
 * persisted the `ScoopConfig` sandbox to disk mixed indistinguishably with
 * appended "Always" grants, so a stale file from a previous scoop generation
 * silently retained authority a narrower replacement config had revoked. They
 * are dropped rather than migrated (fail-closed); a real "Always" grant inside
 * one re-prompts once.
 */
const LEGACY_GENERATED_HEADER =
  '# Per-scoop sudoers — generated from ScoopConfig (sandbox surface).';

/** Dependencies for {@link migrateLegacyScoopSudoers}. */
export interface MigrateScoopSudoersDeps {
  /** RAW VFS handle — the destination is self-protected, so this must bypass the gate. */
  fs: VirtualFS;
  /** Destination drop-in, or `null` for a folder that cannot be spelled as a filename. */
  destPath: string | null;
  /** Header written when the destination does not exist yet. */
  header: string;
}

/** Read `path` as text, or `null` when it is absent or unreadable. */
async function readOrNull(fs: VirtualFS, path: string): Promise<string | null> {
  try {
    if (!(await fs.exists(path))) return null;
    const raw = await fs.readFile(path, { encoding: 'utf-8' });
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    log.warn('Failed to read legacy per-scoop sudoers; treating as absent', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Move `folder`'s legacy in-sandbox grants into `destPath` and delete the
 * original. Idempotent: rules already present in the destination are not
 * duplicated, and removing the source means a second boot finds nothing to do.
 *
 * A failure anywhere leaves the legacy file in place. That is inert, not
 * dangerous — nothing reads policy from it any more — and it keeps the grants
 * recoverable on the next boot instead of destroying them mid-move.
 */
export async function migrateLegacyScoopSudoers(
  folder: string,
  deps: MigrateScoopSudoersDeps
): Promise<void> {
  const { fs, destPath, header } = deps;
  const legacyPath = legacyScoopSudoersPath(folder);
  const existing = await readOrNull(fs, legacyPath);
  if (existing === null) return;

  const isLegacyGenerated = existing.split('\n', 1)[0]?.trim() === LEGACY_GENERATED_HEADER;
  const rules = isLegacyGenerated
    ? []
    : existing
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

  try {
    if (rules.length > 0 && destPath) {
      const current = (await readOrNull(fs, destPath)) ?? '';
      const present = new Set(current.split('\n').map((line) => line.trim()));
      const added = rules.filter((rule) => !present.has(rule));
      if (added.length > 0) {
        const prefix = current ? (current.endsWith('\n') ? current : `${current}\n`) : header;
        await fs.mkdir(SUDOERS_D_DIR, { recursive: true }).catch(() => {});
        await fs.writeFile(destPath, `${prefix}${added.join('\n')}\n`);
      }
    }
    await fs.rm(legacyPath, { recursive: false });
    log.info('Migrated legacy in-sandbox per-scoop sudoers', {
      folder,
      to: destPath,
      rules: rules.length,
      droppedGenerated: isLegacyGenerated,
    });
  } catch (err) {
    log.warn('Failed to migrate legacy per-scoop sudoers; left in place (inert)', {
      folder,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
