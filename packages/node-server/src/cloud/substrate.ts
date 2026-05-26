import type { SandboxSummary as CoreSandboxSummary } from '@slicc/cloud-core';

// MVP recognizes only 'e2b'. Future substrates extend this union when they
// actually exist. Do not enumerate speculative values.
export type SubstrateId = 'e2b';

// Re-export SandboxSummary from cloud-core for backward compatibility with
// existing substrate implementations.
export type SandboxSummary = CoreSandboxSummary;

export interface SubstrateConfig {
  /** Credential for the substrate (e.g. E2B_API_KEY). */
  apiKey: string;
}

export interface CreateOpts {
  template: string;
  envVars: Record<string, string>;
  metadata: Record<string, string>;
  autoPauseOnCap: boolean;
  name?: string;
}

export interface SandboxInfo {
  sandboxId: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
  createdAt: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxHandle {
  readonly sandboxId: string;
  readonly substrate: SubstrateId;
  pause(): Promise<void>;
  kill(): Promise<void>;
  getInfo(): Promise<SandboxInfo>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<string>;
  run(cmd: string): Promise<RunResult>;
}

export interface SandboxSubstrate {
  readonly id: SubstrateId;
  create(opts: CreateOpts): Promise<SandboxHandle>;
  connect(sandboxId: string): Promise<SandboxHandle>;
  list(): Promise<SandboxSummary[]>;
}

export interface SubstrateFactory {
  (id: SubstrateId, cfg: SubstrateConfig): SandboxSubstrate;
}

import { createE2bSubstrate } from './substrates/e2b.js';

export const createSubstrate: SubstrateFactory = (id, cfg) => {
  if (id === 'e2b') return createE2bSubstrate(cfg);
  // SubstrateId is currently the literal 'e2b'; this branch is unreachable today.
  throw new Error(`unknown substrate: ${id}`);
};
