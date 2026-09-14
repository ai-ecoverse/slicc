import type { SudoApproverDirective, SudoKind, SudoRequest } from './types.js';

export interface LeaderSudoApprovalInput {
  kind: SudoKind;
  detail: string;
  suggestedPattern?: string;

  followerLabel?: string;
  hostOrigin?: string;
  approver?: SudoApproverDirective;
}

export function toKernelSudoRequest(input: LeaderSudoApprovalInput): SudoRequest {
  return {
    kind: input.kind,
    detail: input.detail,
    ...(input.followerLabel ? { requester: input.followerLabel } : {}),
    ...(input.approver ? { approver: input.approver } : {}),
    ...(input.suggestedPattern ? { suggestedPattern: input.suggestedPattern } : {}),
  };
}
