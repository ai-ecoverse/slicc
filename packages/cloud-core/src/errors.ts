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
 * Structured context attached to a {@link CloudError}. Carried through to the
 * worker's HTTP error envelope (`errorResponse`) and surfaced to consumers.
 * Today only the cap-exceeded errors populate it; extend this shape rather than
 * widening it back to an untyped bag when a new code needs to carry context.
 */
export interface CloudErrorDetails {
  /** Number of running cones when a running cap was exceeded. */
  running?: number;
  /** Number of paused cones when a paused cap was exceeded. */
  paused?: number;
  /** The cap limit that was exceeded. */
  cap?: number;
  /** The sandbox involved, e.g. when a cone fails to become ready. */
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
