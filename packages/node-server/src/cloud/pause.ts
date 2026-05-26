import { CloudError } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';
import type { SandboxSubstrate } from './substrate.js';

export interface RunPauseOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

export async function runPause(opts: RunPauseOpts): Promise<void> {
  const reg = new FileRegistry(opts.registryPath);
  const entry = await reg.findByNameOrId(opts.query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${opts.query}`);

  const handle = await opts.substrate.connect(entry.sandboxId);
  await handle.pause();
  // Update ONLY state + lastSeen. trayId and lastJoinUpdatedAt are baseline
  // values for the next resume — preserving them is load-bearing.
  await reg.update(entry.sandboxId, { state: 'paused', lastSeen: new Date().toISOString() });
}
