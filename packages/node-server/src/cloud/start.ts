import { promises as fs } from 'node:fs';
import { startCone, type StartResult, type SandboxHandle } from '@slicc/cloud-core';
import type { SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunStartOpts {
  substrate: SandboxSubstrate;
  envFilePath: string;
  registryPath: string;
  workerBaseUrl: string;
  sliccVersion: string;
  template?: string;
  name?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Test-only hook: invoked after substrate.create but before pollCloudStatus. */
  onAfterCreate?: (handle: SandboxHandle) => Promise<void>;
}

export async function runStart(opts: RunStartOpts): Promise<StartResult> {
  const envContents = await fs.readFile(opts.envFilePath, 'utf-8');
  const registry = new FileRegistry(opts.registryPath);

  // If we have a test hook, wrap the substrate to inject it.
  let substrate = opts.substrate;
  if (opts.onAfterCreate) {
    const originalCreate = substrate.create.bind(substrate);
    substrate = {
      ...substrate,
      create: async (createOpts) => {
        const handle = await originalCreate(createOpts);
        await opts.onAfterCreate!(handle);
        return handle;
      },
    };
  }

  return startCone(
    { substrate, registry },
    {
      envContents,
      workerBaseUrl: opts.workerBaseUrl,
      template: opts.template,
      name: opts.name,
      sliccVersion: opts.sliccVersion,
      pollTimeoutMs: opts.pollTimeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      metadata: {
        createdBy: process.env['USER'] ?? 'unknown',
      },
    }
  );
}
