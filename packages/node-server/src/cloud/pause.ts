import { pauseCone, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunPauseOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

export async function runPause(opts: RunPauseOpts): Promise<void> {
  const registry = new FileRegistry(opts.registryPath);
  return pauseCone({ substrate: opts.substrate, registry }, opts.query);
}
