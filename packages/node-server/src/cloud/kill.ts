import { killCone, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunKillOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

/**
 * Thin wrapper over killCone from @slicc/cloud-core.
 * Adapts the cloud-core interface to the node-server's file-backed registry.
 * Returns void for backward compatibility with existing callers.
 */
export async function runKill(opts: RunKillOpts): Promise<void> {
  const registry = new FileRegistry(opts.registryPath);
  await killCone({ substrate: opts.substrate, registry }, opts.query);
}
