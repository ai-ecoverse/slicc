/**
 * Server-side sudo approval types for the node-server float.
 *
 * The browser's `node-rest` `CapabilityBroker` adapter
 * (`packages/webapp/src/work-unit/capability/rest-ops.ts`'s
 * `restRequestApproval`) POSTs a
 * {@link SudoApproveRequest} to `/api/sudo-approve`; this process selects a
 * native backend, raises a real OS dialog / TTY prompt, and returns a
 * {@link SudoDecision}. The decision can only come from a genuine human
 * gesture in this process — the agent's in-browser `node` shim cannot reach
 * here.
 */

/** `export` = a follower's transcript export (issue #2062 folded it into sudo). */
/**
 * Mirror of `TraySudoKind` in `@slicc/shared-ts`. Kept as a local literal union
 * (node-server does not import the browser package) — which means a kind added
 * there must be added HERE too, or `VALID_KINDS` in `endpoint.ts` 400s it and
 * the gate fails closed forever.
 */
export type SudoKind =
  | 'command'
  | 'read'
  | 'write'
  | 'secret'
  | 'export'
  | 'guest-message'
  | 'guest-tool';

/** Inbound request body for `POST /api/sudo-approve`. */
export interface SudoApproveRequest {
  kind: SudoKind;
  /** The concrete command line or VFS path being gated. */
  detail: string;
  /**
   * Who is asking, as the browser side authenticated them. Optional — older
   * clients omit it. Rendered as chrome, never mixed into `detail`, because
   * `detail` can be prose the requester wrote about themselves (a biscotto
   * guest message).
   */
  requester?: string;
  /**
   * The requester's own account of WHY, when they gave one. Optional — older
   * clients omit it. Untrusted prose like `detail`, so every backend renders
   * it AFTER the subject and never above `requester`.
   */
  reason?: string;
  /** Editable default pattern for an "Always" grant (LLM-suggested upstream). */
  suggestedPattern: string;
}

/** The human's decision. `pattern` is only present for `always`. */
export interface SudoDecision {
  decision: 'allow' | 'deny' | 'always';
  pattern?: string;
  /**
   * Why a `deny` was reached when nobody actually refused. Absent for a real
   * gesture (Deny button, TTY `d`, dialog dismiss). Enforcement layers and
   * biscotto review use it to tell a guest "unanswered", not "refused".
   *
   * Node-server only stamps `unavailable` (no approval surface, a dialog
   * binary that could not be spawned, a backend that threw). Timeout reasons
   * live in the webapp broker layer. Mirror of webapp `SudoDecision.reason`.
   *
   * Deliberately a field rather than a fourth `decision` value: every consumer
   * branches on `decision === 'deny'`, so a new variant would fail OPEN.
   */
  reason?: SudoUnansweredReason;
}

/**
 * Why a `deny` carries no human's refusal. See {@link SudoDecision.reason}.
 * Every value means "unanswered"; only the absence of a reason means "refused".
 * Node-server emits only `unavailable`; the timeout values are listed so the
 * wire shape matches the webapp consumer.
 */
export type SudoUnansweredReason = 'user-timeout' | 'cone-timeout' | 'unavailable';

/**
 * The fail-closed decision for a request that never reached an approver.
 * Use this instead of a bare `{ decision: 'deny' }` on any plumbing path: a
 * bare deny is indistinguishable from a human pressing "Deny".
 */
export function unavailableDecision(): SudoDecision {
  return { decision: 'deny', reason: 'unavailable' };
}

/**
 * A native approval channel. `name` is for logging/selection; `prompt` raises
 * the actual gesture. Implementations MUST fail closed (resolve `deny`) on any
 * error, dismissal, or timeout — never throw to the endpoint. Plumbing
 * failures MUST carry {@link unavailableDecision}'s `reason`; only a genuine
 * human refusal is a bare deny.
 */
export interface SudoBackend {
  readonly name: string;
  prompt(req: SudoApproveRequest): Promise<SudoDecision>;
}
