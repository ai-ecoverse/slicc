import { CloudError } from '@slicc/cloud-core';
import { CloudSessionRegistry } from './registry.js';
import type { SandboxSubstrate } from './substrate.js';

export interface RunKillOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

export async function runKill(opts: RunKillOpts): Promise<void> {
  const reg = new CloudSessionRegistry(opts.registryPath);
  const entry = await reg.findByNameOrId(opts.query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${opts.query}`);

  try {
    const handle = await opts.substrate.connect(entry.sandboxId);
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
  }
  await reg.remove(entry.sandboxId);
}
