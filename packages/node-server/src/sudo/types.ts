export type SudoKind =
  | 'command'
  | 'read'
  | 'write'
  | 'secret'
  | 'export'
  | 'guest-message'
  | 'guest-tool';

export interface SudoApproveRequest {
  kind: SudoKind;

  detail: string;

  requester?: string;

  reason?: string;

  suggestedPattern: string;
}

export interface SudoDecision {
  decision: 'allow' | 'deny' | 'always';
  pattern?: string;

  reason?: SudoUnansweredReason;
}

export type SudoUnansweredReason = 'user-timeout' | 'cone-timeout' | 'unavailable';

export function unavailableDecision(): SudoDecision {
  return { decision: 'deny', reason: 'unavailable' };
}

export interface SudoBackend {
  readonly name: string;
  prompt(req: SudoApproveRequest): Promise<SudoDecision>;
}
