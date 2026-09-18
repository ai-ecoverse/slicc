import type { Bash } from 'just-bash';

type ExecutionLimits = NonNullable<ConstructorParameters<typeof Bash>[0]>['executionLimits'];

const SCOOP_FILESYSTEM_LIMITS: Readonly<ExecutionLimits> = {
  maxTraversalEntries: 100_000,
  maxTraversalDepth: 256,
  maxTraversalWork: 100_000,
  maxGlobOperations: 100_000,
  maxLiveBytes: 64 * 1024 * 1024,
  maxInputBytes: 32 * 1024 * 1024,
  maxArchiveBytes: 128 * 1024 * 1024,
  maxArchiveCompressedBytes: 64 * 1024 * 1024,
  maxArchiveEntryBytes: 64 * 1024 * 1024,
  maxArchiveEntries: 100_000,
};

export function filesystemExecutionLimits(
  isScoop: boolean,
  overrides?: ExecutionLimits
): ExecutionLimits | undefined {
  return isScoop ? { ...SCOOP_FILESYSTEM_LIMITS, ...overrides } : overrides;
}
