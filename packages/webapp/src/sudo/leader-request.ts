/**
 * Leader-side → kernel-side mapping for a sudo request.
 *
 * This exists because it was once an inline object literal in `wc-tray.ts`, and
 * that literal silently dropped `approver`: the field was added on the calling
 * side with an object SPREAD, which suppresses TypeScript's excess-property
 * check, so nothing failed to compile. The unit tests mocked
 * `requestSudoApproval` and asserted on what the caller passed, so they were
 * green while production routed every `cone` / `scoop` guest seat to the human
 * broker instead of the configured approver — the entire tier feature was
 * inert.
 *
 * A named, tested function is the fix for that class of bug: the mapping is now
 * something a test can hold, rather than a literal buried in a 900-line UI
 * wiring file that only integration would exercise.
 */

import type { SudoApproverDirective, SudoKind, SudoRequest } from './types.js';

/** What the tray leader knows about a follower-originated gate. */
export interface LeaderSudoApprovalInput {
  kind: SudoKind;
  detail: string;
  suggestedPattern?: string;
  /** Connection-derived label for the asking follower or guest seat. */
  followerLabel?: string;
  hostOrigin?: string;
  approver?: SudoApproverDirective;
}

/**
 * Build the request the kernel receives.
 *
 * `followerLabel` becomes `requester` — the authenticated identity the prompt
 * shows as chrome, kept deliberately separate from `detail`, which for a
 * biscotto's message is prose the requester wrote about themselves.
 *
 * Optional fields are omitted rather than set to `undefined` so the panel
 * bridge payload stays minimal and comparisons in tests are exact.
 */
export function toKernelSudoRequest(input: LeaderSudoApprovalInput): SudoRequest {
  return {
    kind: input.kind,
    detail: input.detail,
    ...(input.followerLabel ? { requester: input.followerLabel } : {}),
    ...(input.approver ? { approver: input.approver } : {}),
    ...(input.suggestedPattern ? { suggestedPattern: input.suggestedPattern } : {}),
  };
}
