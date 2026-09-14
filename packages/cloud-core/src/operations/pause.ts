import { CloudError } from '../errors.js';
import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';

export interface PauseConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export async function pauseCone(deps: PauseConeDeps, query: string): Promise<void> {
  const entry = await deps.registry.findByNameOrId(query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${query}`);
  if (entry.state === 'reserved') {
    throw new CloudError('ALREADY_RUNNING', `cloud session is being started/resumed: ${query}`);
  }
  if (entry.state === 'paused') {
    throw new CloudError('ALREADY_PAUSED', `cloud session is already paused: ${query}`);
  }

  const handle = await deps.substrate.connect(entry.sandboxId);
  await handle.pause();

  await deps.registry.update(entry.sandboxId, {
    state: 'paused',
    lastSeen: new Date().toISOString(),
  });
}
