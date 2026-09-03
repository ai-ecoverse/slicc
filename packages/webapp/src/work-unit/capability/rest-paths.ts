/**
 * The privileged routes the `node-rest` adapter speaks (#2276 slice B).
 *
 * Its own module so the boot-critical adapter shell and the lazily-loaded
 * wire implementation can both name them without either importing the other.
 * Mirrored by `packages/shared-ts/fixtures/capability-rest-contract.json`.
 */
export const REST_CAPABILITY_PATHS = {
  fetchProxy: '/api/fetch-proxy',
  secretsMasked: '/api/secrets/masked',
  secretsPersisted: '/api/secrets',
  secretsSession: '/api/secrets/session',
  sudoApprove: '/api/sudo-approve',
  s3SignAndForward: '/api/s3-sign-and-forward',
  daSignAndForward: '/api/da-sign-and-forward',
} as const;

/**
 * Deadline on the small control-plane calls (secrets, sign-and-forward,
 * approvals) `rest-ops.ts` makes once loaded. Named here — not in
 * `rest-ops.ts` — so `rest-adapter.ts` (boot-critical, statically imported)
 * can bound the LOAD of that lazy chunk with the same number without
 * statically importing the chunk itself, which would defeat the point of
 * lazy-loading it (#2276 slice C).
 */
export const REST_CONTROL_CALL_TIMEOUT_MS = 10_000;
