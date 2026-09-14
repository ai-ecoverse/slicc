import { promises as fs } from 'node:fs';
import type { SandboxSubstrate } from '@slicc/cloud-core';
import { type SandboxHandle, type StartResult, startCone } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export const CLI_START_POLL_TIMEOUT_MS = 180_000;

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

  onAfterCreate?: (handle: SandboxHandle) => Promise<void>;
}

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
      pollTimeoutMs: opts.pollTimeoutMs ?? CLI_START_POLL_TIMEOUT_MS,
      pollIntervalMs: opts.pollIntervalMs,
      metadata: {
        createdBy: process.env['USER'] ?? 'unknown',
      },
    }
  );
}
