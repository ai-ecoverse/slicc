import { killCone, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunKillOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

export async function runKill(opts: RunKillOpts): Promise<void> {
  const registry = new FileRegistry(opts.registryPath);
  await killCone({ substrate: opts.substrate, registry }, opts.query);
}
