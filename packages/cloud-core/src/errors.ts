/**
 * Stable, machine-readable error codes used across cloud operations.
 * Workers' HTTP handlers translate these to HTTP statuses (Plan D maps the
 * codes to 403/404/409/503/500 etc.); CLI commands print them. Adding a new
 * code is fine; renaming/removing one is a breaking change to consumers.
 */
export type CloudErrorCode =
  | 'CAP_EXCEEDED'
  | 'NOT_FOUND'
  | 'NAME_TAKEN'
  | 'ALREADY_PAUSED'
  | 'ALREADY_RUNNING'
  | 'LEADER_NOT_READY'
  | 'SANDBOX_NOT_READY'
  | 'CDP_NOT_READY'
  | 'CDP_ERROR'
  | 'INTERNAL';

export class CloudError extends Error {
  constructor(
    public readonly code: CloudErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export function isCloudError(err: unknown): err is CloudError {
  return err instanceof CloudError;
}
