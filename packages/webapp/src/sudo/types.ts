import type { TraySudoKind } from '@slicc/shared-ts';

export type SudoKind = TraySudoKind;

export type SudoApproverDirective =
  | { kind: 'user' }
  | { kind: 'cone'; unitJid: string }
  | { kind: 'scoop'; scoopName: string; unitJid: string }
  | { kind: 'agent'; unitJid: string };

export interface TurnGuestGate {
  requester: string;

  approver?: SudoApproverDirective;
}

export interface SudoRequest {
  kind: SudoKind;

  detail: string;

  requester?: string;

  approver?: SudoApproverDirective;

  suggestedPattern?: string;

  reason?: string;
}

export interface SudoDecision {
  decision: 'allow' | 'deny' | 'always';

  pattern?: string;

  reason?: SudoTimeoutReason;

  note?: string;

  attestation?: 'biometric' | 'passcode' | 'none';
}

export type SudoTimeoutReason = 'user-timeout' | 'cone-timeout';

export interface SudoRequestOptions {
  signal?: AbortSignal;
}

export interface SudoBroker {
  requestApproval(req: SudoRequest, opts?: SudoRequestOptions): Promise<SudoDecision>;
}

export const SUDO_REQUEST_TYPE = 'sudo-request';

export const SUDO_APPROVE_PATH = '/api/sudo-approve';
