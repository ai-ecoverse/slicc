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
  /**
   * `true` when `connect` could not restore the paused sandbox's memory and
   * cold-booted it from its persisted disk instead (see
   * {@link ConnectOpts.rebootIfUnresponsive}). Files written and flushed before
   * the pause are there; running processes — including the hosted node-server —
   * are not, and writes not flushed before the pause are lost. Unset otherwise.
   */
  readonly coldBooted?: boolean;
  pause(): Promise<void>;
  kill(): Promise<void>;
  getInfo(): Promise<SandboxInfo>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<string>;
  run(cmd: string): Promise<RunResult>;
  /**
   * Start a long-running command detached from this call: resolves once the
   * process is spawned, not when it exits, and the process outlives the call.
   * Used to restart the hosted leader after a cold boot; optional because only
   * substrates that can cold-boot need it.
   */
  spawn?(cmd: string): Promise<void>;
}

export interface ConnectOpts {
  /**
   * The substrate can refuse to restore a paused sandbox's memory snapshot
   * because that snapshot was taken while the guest was not responding (e2b:
   * `GuestUnresponsiveError`). With this set, `connect` retries ONCE, cold-
   * booting the sandbox from its persisted disk, and marks the handle
   * `coldBooted`; the first attempt is always a normal memory restore. Without
   * it — or when the cold boot fails too — `connect` throws
   * `CloudError('SANDBOX_UNRESPONSIVE')`. Opt in only where the cold boot is
   * surfaced to the user (resume) or moot (kill).
   */
  rebootIfUnresponsive?: boolean;
}

export interface ListOpts {
  metadata?: Record<string, string>;
}

export interface SandboxSubstrate {
  readonly id: SubstrateId;
  create(opts: CreateOpts): Promise<SandboxHandle>;
  connect(sandboxId: string, opts?: ConnectOpts): Promise<SandboxHandle>;
  list(opts?: ListOpts): Promise<SandboxSummary[]>;
  /**
   * Reset the sandbox's auto-pause countdown. The substrate-specific TTL
   * floor applies (e.g. e2b Hobby plan caps at 1h, Pro at 24h). For non-e2b
   * substrates that don't support this concept, implement as a no-op.
   */
  extendTimeout(sandboxId: string, ttlMs: number): Promise<void>;
  /**
   * Delete a sandbox by ID without connecting to it, from any state. Resolves
   * `false` when the substrate does not know the sandbox. Optional: without it
   * `killCone` connects first, which resumes a paused sandbox just to kill it
   * and fails when the sandbox cannot be resumed at all.
   */
  killById?(sandboxId: string): Promise<boolean>;
}

export type SubstrateFactory = (id: SubstrateId, cfg: SubstrateConfig) => SandboxSubstrate;
