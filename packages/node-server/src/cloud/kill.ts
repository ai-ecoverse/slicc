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
  if (!entry) throw new Error(`cloud session not found: ${opts.query}`);

  try {
    const handle = await opts.substrate.connect(entry.sandboxId);
    await handle.kill();
  } catch {
    // Substrate doesn't know about it — registry cleanup still proceeds.
  }
  await reg.remove(entry.sandboxId);
}
