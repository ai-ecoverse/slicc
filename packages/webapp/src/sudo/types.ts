/**
 * Shared types for the sudo approval broker.
 *
 * The broker is owned by the trusted shell/orchestrator realm. The agent's
 * code-exec sandboxes can only *request* an approval through this interface;
 * they can never fabricate the result. See the workspace spec, "Why this is
 * hard (threat model)".
 */

/** What kind of sensitive action is being gated. */
export type SudoKind = 'command' | 'read' | 'write' | 'secret';

/** A request for native human approval. */
export interface SudoRequest {
  kind: SudoKind;
  /** The concrete command line or VFS path being gated. */
  detail: string;
  /**
   * Optional caller-supplied default pattern for the "Always" grant. When
   * omitted the broker derives one via `quickLabel` (see `suggest-pattern`).
   */
  suggestedPattern?: string;
}

/** The human's decision. `pattern` is only present for `always`. */
export interface SudoDecision {
  decision: 'allow' | 'deny' | 'always';
  /** The (human-edited) glob pattern to persist as a NOPASSWD rule. */
  pattern?: string;
  /**
   * Why a `deny` was reached when nobody actually refused. Absent for a real
   * gesture. Enforcement layers use it to tell the agent "unanswered", not
   * "refused", so it does not immediately re-request the same action.
   *
   *   - `user-timeout` — the native prompt went unanswered past the approval
   *     budget (`USER_SUDO_TIMEOUT_MS`). The human was not at the machine.
   *   - `cone-timeout` — a scoop's cone-mediated request went unanswered past
   *     `CONE_SUDO_TIMEOUT_MS`. No human was ever prompted; the cone agent is
   *     the approver on that leg, so the recovery advice differs.
   *
   * Deliberately a field rather than a fourth `decision` value: every consumer
   * branches on `decision === 'deny'`, so a new variant would fail OPEN.
   */
  reason?: SudoTimeoutReason;
}

/** Which approval leg ran out of time. See {@link SudoDecision.reason}. */
export type SudoTimeoutReason = 'user-timeout' | 'cone-timeout';

/** Per-call options every {@link SudoBroker} accepts. */
export interface SudoRequestOptions {
  /**
   * Cancels the approval attempt. `withApprovalTimeout` aborts this when the
   * budget expires, so a broker whose pre-prompt work (pattern suggestion,
   * transport setup) is still in flight MUST NOT go on to raise a native
   * prompt for an action the caller has already abandoned.
   */
  signal?: AbortSignal;
}

/** Trusted-realm approval surface. */
export interface SudoBroker {
  requestApproval(req: SudoRequest, opts?: SudoRequestOptions): Promise<SudoDecision>;
}

/**
 * Wire `type` tag for the offscreen → side-panel sudo request envelope in
 * extension mode. Both ends agree on this literal — see `extension-broker.ts`
 * and `panel-responder.ts`.
 */
export const SUDO_REQUEST_TYPE = 'sudo-request';

/** Path of the CLI/Electron node-server approval endpoint. */
export const SUDO_APPROVE_PATH = '/api/sudo-approve';
