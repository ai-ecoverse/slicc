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
