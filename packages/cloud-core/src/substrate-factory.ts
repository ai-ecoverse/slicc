import type { SandboxSubstrate, SubstrateConfig, SubstrateId } from './substrate.js';
import { createE2bSubstrate } from './substrates/e2b.js';

export function createSubstrate(id: SubstrateId, cfg: SubstrateConfig): SandboxSubstrate {
  if (id === 'e2b') return createE2bSubstrate(cfg);
  throw new Error(`unknown substrate: ${id satisfies never}`);
}
