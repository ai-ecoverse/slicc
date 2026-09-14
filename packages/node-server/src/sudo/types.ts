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

  suggestedPattern: string;
}

export interface SudoDecision {
  decision: 'allow' | 'deny' | 'always';
  pattern?: string;
}

export interface SudoBackend {
  readonly name: string;
  prompt(req: SudoApproveRequest): Promise<SudoDecision>;
}
