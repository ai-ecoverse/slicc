/**
 * Server-side sudo approval types for the node-server float.
 *
 * The browser broker (`packages/webapp/src/sudo/http-broker.ts`) POSTs a
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
  /** Editable default pattern for an "Always" grant (LLM-suggested upstream). */
  suggestedPattern: string;
}

/** The human's decision. `pattern` is only present for `always`. */
export interface SudoDecision {
  decision: 'allow' | 'deny' | 'always';
  pattern?: string;
}

/**
 * A native approval channel. `name` is for logging/selection; `prompt` raises
 * the actual gesture. Implementations MUST fail closed (resolve `deny`) on any
 * error, dismissal, or timeout — never throw to the endpoint.
 */
export interface SudoBackend {
  readonly name: string;
  prompt(req: SudoApproveRequest): Promise<SudoDecision>;
}
