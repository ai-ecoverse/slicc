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
  | 'DO_UNREACHABLE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

/**
 * Optional machine-readable diagnostics attached to a {@link CloudError}.
 * Each field is populated only for the codes it makes sense for: `running`/`cap`
 * and `paused`/`cap` accompany `CAP_EXCEEDED`, and `sandboxId` accompanies
 * `SANDBOX_NOT_READY`. Consumers read these to surface actionable detail (the
 * worker forwards them into its HTTP error envelope).
 */
export interface CloudErrorDetails {
  /** Number of running cones at the time a running-cap `CAP_EXCEEDED` was thrown. */
  running?: number;
  /** Number of paused cones at the time a paused-cap `CAP_EXCEEDED` was thrown. */
  paused?: number;
  /** The cap that was hit, for a `CAP_EXCEEDED` error. */
  cap?: number;
  /** The sandbox whose boot failed, for a `SANDBOX_NOT_READY` error. */
  sandboxId?: string;
}

export class CloudError extends Error {
  constructor(
    public readonly code: CloudErrorCode,
    message: string,
    public readonly details?: CloudErrorDetails
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export function isCloudError(err: unknown): err is CloudError {
  return err instanceof CloudError;
}
