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
   * Why a `deny` was reached when no human actually refused. Absent for a real
   * gesture. `'timeout'` means the prompt went unanswered past the approval
   * budget (see `approval-timeout.ts` / `CONE_SUDO_TIMEOUT_MS`) — enforcement
   * layers use it to tell the agent "unanswered", not "refused", so it does
   * not immediately re-request the same action. Deliberately a field rather
   * than a fourth `decision` value: every consumer branches on
   * `decision === 'deny'`, so a new variant would fail OPEN.
   */
  reason?: 'timeout';
}

/** Trusted-realm approval surface. */
export interface SudoBroker {
  requestApproval(req: SudoRequest): Promise<SudoDecision>;
}

/**
 * Wire `type` tag for the offscreen → side-panel sudo request envelope in
 * extension mode. Both ends agree on this literal — see `extension-broker.ts`
 * and `panel-responder.ts`.
 */
export const SUDO_REQUEST_TYPE = 'sudo-request';

/** Path of the CLI/Electron node-server approval endpoint. */
export const SUDO_APPROVE_PATH = '/api/sudo-approve';
