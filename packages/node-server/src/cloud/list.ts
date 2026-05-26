import type { ConeEntry } from '@slicc/cloud-core';
import { CloudSessionRegistry } from './registry.js';
import type { SandboxSubstrate } from './substrate.js';

export interface RunListOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
}

export async function runList(opts: RunListOpts): Promise<ConeEntry[]> {
  const reg = new CloudSessionRegistry(opts.registryPath);
  const entries = await reg.list();
  if (entries.length === 0) return [];

  const live = await opts.substrate.list();
  const liveById = new Map(live.map((s) => [s.sandboxId, s] as const));

  return entries.map((e) => {
    const liveEntry = liveById.get(e.sandboxId);
    if (!liveEntry) return { ...e, state: 'dead' as const };
    return { ...e, state: liveEntry.state };
  });
}
