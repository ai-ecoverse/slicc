import { promises as fs } from 'node:fs';
import type { SandboxSubstrate } from '@slicc/cloud-core';
import { type SandboxHandle, type StartResult, startCone } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

/**
 * CLI poll budget for `/tmp/slicc-join.json` to appear after sandbox create.
 *
 * cloud-core defaults this to 60s, which is too tight for a COLD boot of the
 * hosted-leader image: start.sh budgets chromium cold-start alone at 60s
 * (SLICC_CDP_LAUNCH_TIMEOUT_MS), and node boot + tray registration push the
 * observed first-boot time to ~50-70s. The 60s default loses that race on the
 * coldest (first-after-build) boot, surfacing as a spurious SANDBOX_NOT_READY.
 *
 * The worker path deliberately keeps the tighter 60s default (its request is
 * wall-clock-constrained by the dashboard fetch / CF edge), but a laptop CLI
 * can afford to wait — so we give it generous headroom here.
 */
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
      pollTimeoutMs: opts.pollTimeoutMs ?? CLI_START_POLL_TIMEOUT_MS,
      pollIntervalMs: opts.pollIntervalMs,
      metadata: {
        createdBy: process.env['USER'] ?? 'unknown',
      },
    }
  );
}
