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

/**
 * Warnings `slicc --cloud resume` prints before the join URL. A cold boot is
 * listed first: the user has to know that the sandbox came back from its disk
 * and that in-flight work and unflushed writes did not survive.
 */
export function resumeWarnings(result: ResumeResult): string[] {
  const warnings: string[] = [];
  if (result.coldBooted) {
    warnings.push(
      'Warning: the sandbox could not be resumed with its memory (its guest was unresponsive ' +
        'when it was paused), so it was cold-booted from its disk. Files saved before the pause ' +
        'are intact, but running work restarted and writes not flushed before the pause were lost.'
    );
  }
  if (result.versionMismatch) {
    warnings.push(
      `Warning: running sandbox is sliccVersion=${result.versionMismatch.running}, ` +
        `local CLI is ${result.versionMismatch.local}. Proceeding anyway.`
    );
  }
  if (result.trayRebuilt) {
    warnings.push('Tray was rebuilt; existing followers must re-attach to the new join URL.');
  }
  return warnings;
}
