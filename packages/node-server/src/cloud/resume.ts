import { promises as fs } from 'node:fs';
import { type ResumeResult, resumeCone, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunResumeOpts {
  substrate: SandboxSubstrate;
  envFilePath: string;
  registryPath: string;
  query: string;
  localSliccVersion: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export async function runResume(opts: RunResumeOpts): Promise<ResumeResult> {
  // Refresh on resume so cones paused for >24h pick up a freshly-issued token
  // from the local secrets.env. This was a pre-existing CLI gap — resume would
  // succeed but Adobe LLM calls would 401 on expired tokens.
  const envContents = await fs.readFile(opts.envFilePath, 'utf-8');
  const registry = new FileRegistry(opts.registryPath);
  return resumeCone(
    { substrate: opts.substrate, registry },
    {
      query: opts.query,
      localSliccVersion: opts.localSliccVersion,
      refreshSecretsContents: envContents,
      pollIntervalMs: opts.pollIntervalMs,
      pollTimeoutMs: opts.pollTimeoutMs,
    }
  );
}
