/**
 * Per-realm singleton holding the page's secret-entry surface — the one place
 * a human hands SLICC a credential.
 *
 * Lives in `base/` (the bottom rung of the layer stack) so every ranked layer
 * can resolve it without importing upward: `tools/request-secret-tool.ts` needs
 * it, and so would any future shell command. The UI layer owns registering it
 * (`ui/wc/wc-secret-request.ts` is the only setter).
 *
 * The surface, not its callers, holds the plaintext: it opens
 * `<slicc-secret-dialog>` in the trusted layer, writes to the secret store, and
 * hands back only the MASKED stand-in. That is what makes it safe for an
 * agent-invoked tool to trigger — the tool learns a name and a mask, never the
 * credential.
 *
 * `null` when no surface is registered (a follower with no reachable secret
 * store, pre-boot, or after dispose).
 */

/** What the caller is asking a human for. */
export interface SecretRequest {
  /** Suggested secret name (`GITHUB_TOKEN`, `s3.r2.access_key_id`). */
  name?: string;
  /** Suggested domain allowlist; the human can edit or widen it. */
  domains?: string[];
  /** Why it is needed. Shown verbatim, so keep it one plain sentence. */
  reason?: string;
  /** Who is asking — a system-derived label, never model-authored prose. */
  requester?: string;
  /** Start with "keep after this session ends" checked. */
  persist?: boolean;
}

/** A stored secret, described WITHOUT its value. */
export interface SecretRequestStored {
  stored: true;
  /** The store key the human confirmed (may differ from the suggestion). */
  name: string;
  /**
   * The session-stable masked stand-in. Safe for agent context: the fetch proxy
   * swaps in the real value at the network boundary, and only for `domains`.
   * `null` when the store accepted the write but could not report a mask.
   */
  maskedValue: string | null;
  /** The scope the human confirmed. */
  domains: string[];
  /** true → written to the saved store; false → in-memory for this session. */
  persisted: boolean;
}

/** Nothing was stored, and why. */
export interface SecretRequestDeclined {
  stored: false;
  /** `cancelled` — the human dismissed the dialog; `unavailable` — no surface. */
  reason: 'cancelled' | 'unavailable' | 'failed';
  /** Operator-readable detail for `failed`. */
  detail?: string;
}

export type SecretRequestOutcome = SecretRequestStored | SecretRequestDeclined;

/** The page-realm capability the registry hands out. */
export type SecretRequestSurface = (request: SecretRequest) => Promise<SecretRequestOutcome>;

let surface: SecretRequestSurface | null = null;

/** The registered secret-entry surface, or `null` when this float has none. */
export function getSecretRequestSurface(): SecretRequestSurface | null {
  return surface;
}

/** Register the surface. Passing `null` clears the registry. */
export function setSecretRequestSurface(value: SecretRequestSurface | null): void {
  surface = value;
}
