import type { SandboxSummary } from './types.js';

// MVP recognizes only 'e2b'. Future substrates extend this union when they
// actually exist. Do not enumerate speculative values.
export type SubstrateId = 'e2b';

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

export interface ListOpts {
  metadata?: Record<string, string>;
}

export interface SandboxSubstrate {
  readonly id: SubstrateId;
  create(opts: CreateOpts): Promise<SandboxHandle>;
  connect(sandboxId: string): Promise<SandboxHandle>;
  list(opts?: ListOpts): Promise<SandboxSummary[]>;
  /**
   * Reset the sandbox's auto-pause countdown. The substrate-specific TTL
   * floor applies (e.g. e2b Hobby plan caps at 1h, Pro at 24h). For non-e2b
   * substrates that don't support this concept, implement as a no-op.
   */
  extendTimeout(sandboxId: string, ttlMs: number): Promise<void>;
}

export interface SubstrateFactory {
  (id: SubstrateId, cfg: SubstrateConfig): SandboxSubstrate;
}
