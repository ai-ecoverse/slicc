export const REST_CAPABILITY_PATHS = {
  fetchProxy: '/api/fetch-proxy',
  secretsMasked: '/api/secrets/masked',
  secretsPersisted: '/api/secrets',
  secretsSession: '/api/secrets/session',
  sudoApprove: '/api/sudo-approve',
  s3SignAndForward: '/api/s3-sign-and-forward',
  daSignAndForward: '/api/da-sign-and-forward',
} as const;

export const REST_CONTROL_CALL_TIMEOUT_MS = 10_000;
