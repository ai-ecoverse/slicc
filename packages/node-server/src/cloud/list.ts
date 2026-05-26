import { listCones, type ConeEntry } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';
import type { SandboxSubstrate } from './substrate.js';

export interface RunListOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
}

export async function runList(opts: RunListOpts): Promise<ConeEntry[]> {
  const registry = new FileRegistry(opts.registryPath);
  return listCones({ substrate: opts.substrate, registry });
}
