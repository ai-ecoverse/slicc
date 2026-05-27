import { CloudError } from '../errors.js';
import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';

export interface KillConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export interface KillConeResult {
  sandboxId: string;
  alreadyDead: boolean;
}

/**
 * Kill a cloud cone and remove it from the registry.
 * Discriminates between "not found" substrate errors (sandbox is already gone,
 * safe to clean up registry) and other errors (network issues, auth failures, etc.)
 * which are re-thrown to surface the problem without silently leaking credits.
 */
export async function killCone(deps: KillConeDeps, query: string): Promise<KillConeResult> {
  const entry = await deps.registry.findByNameOrId(query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${query}`);

  let alreadyDead = false;
  try {
    const handle = await deps.substrate.connect(entry.sandboxId);
    await handle.kill();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only proceed with registry cleanup if substrate reports "not found".
    // Other errors (timeouts, auth failures) might leave a sandbox running;
    // surface them so the user doesn't silently leak credits.
    const notFound = /not found|unknown sandbox|404|does not exist/i.test(msg);
    if (!notFound) {
      throw new CloudError(
        'INTERNAL',
        `substrate.kill failed (sandbox ${entry.sandboxId}): ${msg}. ` +
          `Registry entry NOT removed — verify sandbox state manually.`
      );
    }
    // else: substrate doesn't know about it; registry cleanup proceeds below.
    alreadyDead = true;
  }
  await deps.registry.remove(entry.sandboxId);
  return { sandboxId: entry.sandboxId, alreadyDead };
}
