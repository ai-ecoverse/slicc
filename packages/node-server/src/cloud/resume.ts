import { resumeCone, type ResumeResult, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunResumeOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
  localSliccVersion: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export async function runResume(opts: RunResumeOpts): Promise<ResumeResult> {
  const registry = new FileRegistry(opts.registryPath);
  return resumeCone(
    { substrate: opts.substrate, registry },
    {
      query: opts.query,
      localSliccVersion: opts.localSliccVersion,
      pollIntervalMs: opts.pollIntervalMs,
      pollTimeoutMs: opts.pollTimeoutMs,
      // refreshSecretsContents: undefined — CLI Plan B may add this in a later task
    }
  );
}
