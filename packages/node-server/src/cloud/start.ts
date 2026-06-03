import { promises as fs } from 'node:fs';
import type { SandboxSubstrate } from '@slicc/cloud-core';
import { type SandboxHandle, type StartResult, startCone } from '@slicc/cloud-core';
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

/**
 * Extract ADOBE_IMS_TOKEN (+ DOMAINS) from an env-file body so they can be
 * injected as sandbox env vars at Sandbox.create. start.sh writes them to
 * /slicc/secrets.env BEFORE node-server boots, eliminating the historical 5s
 * race window where the page-side bootstrap fetch found no secrets file.
 */
function extractAdobeBootstrap(envContents: string): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const line of envContents.split('\n')) {
    const m = line.match(/^\s*(ADOBE_IMS_TOKEN(?:_DOMAINS)?)\s*=\s*(.*)$/);
    if (m) envs[m[1]!] = m[2]!.trim();
  }
  return envs;
}

export async function runStart(opts: RunStartOpts): Promise<StartResult> {
  const envContents = await fs.readFile(opts.envFilePath, 'utf-8');
  const adobeBootstrap = extractAdobeBootstrap(envContents);
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
      envs: adobeBootstrap,
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
