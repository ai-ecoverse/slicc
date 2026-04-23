/** Configuration for a single load test run. */
export interface LoadTestConfig {
  /** Number of parallel SLICC instances to spawn. */
  instances: number;
  /** Single prompt sent to all instances (mutually exclusive with promptsFile). */
  prompt?: string;
  /** Path to JSONL file with per-instance prompts/expectations. */
  promptsFile?: string;
  /** Starting port number; instances get basePort, basePort+10, basePort+20, ... */
  basePort: number;
  /** Max seconds to wait for each instance to complete. */
  timeoutSeconds: number;
  /** Optional path to .env file for API keys. */
  envFile?: string;
  /** Adobe IMS access token — injected into each instance's localStorage. */
  adobeToken?: string;
  /** Model ID to select (default: claude-sonnet-4-6). */
  modelId?: string;
  /** Bedrock CAMP provider config — injected into localStorage. */
  bedrockApiKey?: string;
  bedrockBaseUrl?: string;
  bedrockModelId?: string;
  /** Skip interactive wait between Phase 1 and Phase 2. */
  noWait?: boolean;
  /** Path to unpacked Chrome extension (enables extension mode). */
  extensionPath?: string;
  /** URL to navigate to before opening side panel. */
  extensionUrl?: string;
}

/** A step in a multi-step scenario. */
export type ScenarioStep =
  | { type: 'prompt'; text: string }
  | { type: 'click-sprinkle-button'; label: string }
  | { type: 'click-button'; label: string }
  | { type: 'wait-idle' }
  | { type: 'wait-sprinkle-text'; text: string }
  | { type: 'wait-text'; text: string }
  | { type: 'browse'; url: string; script: string; waitMs?: number }
  | { type: 'send-lick'; action: string };

/** A test scenario — either a simple prompt or a multi-step sequence. */
export interface Scenario {
  /** The prompt to send (simple single-prompt mode). */
  prompt: string;
  /** Steps to run during Phase 1 (prepare). */
  prepareSteps?: ScenarioStep[];
  /** Steps to run during Phase 2 (execute). If present, overrides `prompt`. */
  steps?: ScenarioStep[];
  /** If set, verify this VFS file exists after completion. */
  expectFile?: string;
  /** If set, verify the file contains this substring. */
  expectContains?: string;
}

/** Final result for a single instance run. */
export interface InstanceResult {
  index: number;
  port: number;
  prompt: string;
  result: 'pass' | 'fail' | 'timeout' | 'error';
  durationMs: number | null;
  error?: string;
}

/** Final report for the entire load test run. */
export interface LoadTestReport {
  config: LoadTestConfig;
  startedAt: string;
  completedAt: string;
  instances: InstanceResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    timedOut: number;
    errored: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
  };
}
