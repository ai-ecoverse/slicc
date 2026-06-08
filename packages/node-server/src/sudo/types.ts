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

export type SudoKind = 'command' | 'read' | 'write' | 'secret';

/** Inbound request body for `POST /api/sudo-approve`. */
export interface SudoApproveRequest {
  kind: SudoKind;
  /** The concrete command line or VFS path being gated. */
  detail: string;
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
