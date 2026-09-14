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

export interface CloudErrorDetails {
  running?: number;

  paused?: number;

  cap?: number;

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
