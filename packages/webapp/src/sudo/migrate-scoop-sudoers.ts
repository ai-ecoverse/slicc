import { createLogger } from '../base/logger.js';
import { legacyScoopSudoersPath } from '../base/sudoers.js';
import type { VirtualFS } from '../fs/index.js';

const log = createLogger('sudo:migrate');

export interface MigrateScoopSudoersDeps {
  fs: VirtualFS;
}

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
