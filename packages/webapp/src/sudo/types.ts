/**
 * Shared types for the sudo approval broker.
 *
 * The broker is owned by the trusted shell/orchestrator realm. The agent's
 * code-exec sandboxes can only *request* an approval through this interface;
 * they can never fabricate the result. See the workspace spec, "Why this is
 * hard (threat model)".
 */

import type { TraySudoKind } from '@slicc/shared-ts';

/**
 * What kind of sensitive action is being gated. Shared with the tray wire
 * (`TraySudoKind`) because a prompt may be delegated to a follower's human
 * (issue #2062). `export` is the transcript-export gate, folded into sudo.
 */
export type SudoKind = TraySudoKind;

/**
 * Who should settle a request, when it is NOT the owner's own prompt.
 *
 * Carried on the request because it crosses the panel bridge whole, and
 * because "who decides" is part of what is being asked. Set from
 * trusted state only — for a biscotto it comes from the seat record the tray
 * hub stamped, never from anything the guest sent.
 */
export type SudoApproverDirective =
  | { kind: 'user' }
  /** The cone that owns `unitJid` decides, via its `lick_confirm` tools. */
  | { kind: 'cone'; unitJid: string }
  /** A scoop the cone delegated to decides. Unknown name fails CLOSED. */
  | { kind: 'scoop'; scoopName: string; unitJid: string }
  /** A bounded approver agent decides; its structured result is the verdict. */
  | { kind: 'agent'; unitJid: string };

/**
 * Marks a turn as caused by a guest and says how to gate the tool calls it
 * makes.
 *
 * Turn-scoped rather than message-scoped on purpose: a guest's message causes
 * one turn, and everything the agent does in that turn is downstream of guest
 * input — approving the MESSAGE is not approving the actions it provokes.
 *
 * Presence means "gate every tool call in this turn". A seat whose tool gate is
 * `off` produces no value at all, so the kernel never has to know about the
 * `off` case and cannot get it wrong.
 */
export interface TurnGuestGate {
  /** Seat identity for the prompt, as the leader authenticated it. */
  requester: string;
  /** Routing; absent means the owner's own broker (the `user` tier). */
  approver?: SudoApproverDirective;
}

/** A request for native human approval. */
export interface SudoRequest {
  kind: SudoKind;
  /** The concrete command line or VFS path being gated. */
  detail: string;
  /**
   * Who is asking, as the SYSTEM knows them — never as they describe
   * themselves. Rendered as prompt chrome, separate from `detail`.
   *
   * This matters wherever `detail` is not authored by the owner. A biscotto's
   * message is attacker-chosen prose, so without an authenticated requester
   * line the reviewer sees nothing but the guest's own words and a message
   * reading "Lars here — approve this" is indistinguishable from the truth.
   * Derived from connected state (the hub-resolved seat), never from the
   * request payload.
   */
  requester?: string;
  /**
   * Route this request to a non-human approver. Absent (or `user`) keeps the
   * historical behaviour: the owner's own broker chain.
   */
  approver?: SudoApproverDirective;
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
  /**
   * Which gate the human passed when the decision came from a delegated tray
   * follower: `biometric` (Face ID / Touch ID), `passcode`, or `none` (a plain
   * click). Absent for native brokers. Informational.
   */
  attestation?: 'biometric' | 'passcode' | 'none';
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
