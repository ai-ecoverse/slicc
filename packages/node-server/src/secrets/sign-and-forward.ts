/**
 * Server-side request signing for S3 and Adobe da.live mounts.
 *
 * The browser-side mount backends never see real S3 credentials or the IMS
 * bearer token. They post envelopes to `/api/s3-sign-and-forward` and
 * `/api/da-sign-and-forward`, which:
 *  1. Validate the envelope.
 *  2. Resolve credentials server-side (S3) or accept a transient bearer (DA).
 *  3. Reconstruct the upstream URL from profile config (S3) or the path
 *     prefix (DA) — so the browser cannot SSRF arbitrary hosts.
 *  4. Sign with SigV4 v4 (S3) or attach `Authorization: Bearer` (DA).
 *  5. Forward to the upstream and return the response as a JSON envelope.
 *
 * Logging contract: never log envelope contents — request bodies or the
 * `imsToken` may contain credential material.
 */

import type { Request, Response } from 'express';

import { signSigV4 } from './signing-s3.js';
import type { SecretStore } from './types.js';

/** Allowed characters in profile names — restricts secret-key path traversal. */
const PROFILE_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/** Methods we permit through the signed proxies. */
const ALLOWED_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'] as const;
type SignedMethod = (typeof ALLOWED_METHODS)[number];

/**
 * Hop-by-hop headers — per RFC 7230 these are connection-scoped and must not
 * be propagated upstream / downstream. Lowercase for comparison.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Adobe da.live API origin. Hard-coded — clients send only the path component. */
const DA_ORIGIN = 'https://admin.da.live';

// ----------------- envelope shapes -----------------

export interface S3SignAndForwardEnvelope {
  profile: string;
  method: SignedMethod;
  bucket: string;
  /** S3 key (the prefix is already baked in by the backend). */
  key: string;
  query?: Record<string, string>;
  /** Extra headers from the backend (If-Match, Content-Type, ...). */
  headers?: Record<string, string>;
  /** Request body, base64-encoded. Null/absent for GET/HEAD/DELETE/listing. */
  bodyBase64?: string | null;
}

export interface DaSignAndForwardEnvelope {
  /** IMS bearer token, passed transiently. Never persisted server-side. */
  imsToken: string;
  method: SignedMethod;
  /** Path including leading slash, e.g. `/source/<org>/<repo>/<key>`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyBase64?: string | null;
}

interface S3Profile {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  endpoint?: string;
  pathStyle: boolean;
}

class ProfileNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileNotConfiguredError';
  }
}

// ----------------- helpers -----------------

function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function isAllowedMethod(m: unknown): m is SignedMethod {
  return typeof m === 'string' && (ALLOWED_METHODS as readonly string[]).includes(m);
}

function readSecretValue(store: SecretStore, key: string): string | undefined {
  const secret = store.get(key);
  return secret?.value;
}

function resolveS3Profile(name: string, store: SecretStore): S3Profile {
  const accessKeyId = readSecretValue(store, `s3.${name}.access_key_id`);
  const secretAccessKey = readSecretValue(store, `s3.${name}.secret_access_key`);

  if (!accessKeyId) {
    throw new ProfileNotConfiguredError(
      `profile '${name}' missing required field 'access_key_id'. ` +
        `Set it via: secret set s3.${name}.access_key_id <value>`
    );
  }
  if (!secretAccessKey) {
    throw new ProfileNotConfiguredError(
      `profile '${name}' missing required field 'secret_access_key'. ` +
        `Set it via: secret set s3.${name}.secret_access_key <value>`
    );
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: readSecretValue(store, `s3.${name}.session_token`),
    region: readSecretValue(store, `s3.${name}.region`) ?? 'us-east-1',
    endpoint: readSecretValue(store, `s3.${name}.endpoint`),
    pathStyle: readSecretValue(store, `s3.${name}.path_style`) === 'true',
  };
}

/** Build the S3 URL based on profile addressing style. */
function buildS3Url(
  profile: S3Profile,
  bucket: string,
  key: string,
  query?: Record<string, string>
): URL {
  // Determine host from explicit endpoint (R2/MinIO) or AWS region default.
  let host: string;
  if (profile.endpoint) {
    try {
      host = new URL(profile.endpoint).host;
    } catch {
      throw new Error(`profile endpoint is not a valid URL: ${profile.endpoint}`);
    }
  } else {
    host = `s3.${profile.region}.amazonaws.com`;
  }

  // Encode key segment-by-segment so '/' is preserved.
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const encodedBucket = encodeURIComponent(bucket);

  const pathPart = profile.pathStyle ? `${encodedBucket}/${encodedKey}` : encodedKey;
  const hostPart = profile.pathStyle ? host : `${encodedBucket}.${host}`;
  const url = new URL(`https://${hostPart}/${pathPart}`);

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url;
}

/** Copy upstream response headers, dropping hop-by-hop entries. */
function passthroughHeaders(upstream: globalThis.Response): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}

// ----------------- handlers -----------------

/**
 * Handle a `POST /api/s3-sign-and-forward` request. Validates the envelope,
 * resolves credentials, signs, forwards, returns a JSON envelope.
 *
 * Errors in setup return 400 with a structured `{ ok: false, error, errorCode }`.
 * Network errors against the upstream return 502.
 */
export async function handleS3SignAndForward(
  req: Request,
  res: Response,
  secretStore: SecretStore
): Promise<void> {
  const env = req.body as Partial<S3SignAndForwardEnvelope> | undefined;

  if (
    typeof env?.profile !== 'string' ||
    env.profile.length === 0 ||
    !PROFILE_NAME_REGEX.test(env.profile)
  ) {
    res.status(400).json({
      ok: false,
      error: 'invalid profile name (allowed: alphanumeric, dot, underscore, hyphen)',
      errorCode: 'invalid_profile',
    });
    return;
  }
  if (!isAllowedMethod(env.method)) {
    res.status(400).json({ ok: false, error: 'invalid method', errorCode: 'invalid_request' });
    return;
  }
  if (typeof env.bucket !== 'string' || env.bucket.length === 0) {
    res.status(400).json({ ok: false, error: 'invalid bucket', errorCode: 'invalid_request' });
    return;
  }
  if (typeof env.key !== 'string') {
    res.status(400).json({ ok: false, error: 'invalid key', errorCode: 'invalid_request' });
    return;
  }

  let profile: S3Profile;
  try {
    profile = resolveS3Profile(env.profile, secretStore);
  } catch (err) {
    if (err instanceof ProfileNotConfiguredError) {
      res.status(400).json({
        ok: false,
        error: err.message,
        errorCode: 'profile_not_configured',
      });
      return;
    }
    throw err;
  }

  let url: URL;
  try {
    url = buildS3Url(profile, env.bucket, env.key, env.query);
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : 'failed to build URL',
      errorCode: 'invalid_request',
    });
    return;
  }

  const body =
    typeof env.bodyBase64 === 'string' && env.bodyBase64.length > 0
      ? decodeBase64(env.bodyBase64)
      : undefined;

  const signed = await signSigV4(
    {
      method: env.method,
      url,
      headers: { ...(env.headers ?? {}), Host: url.host },
      body,
    },
    {
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
      sessionToken: profile.sessionToken,
    },
    profile.region,
    's3'
  );

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url.toString(), {
      method: signed.method,
      headers: signed.headers,
      // Cast: TS 6 narrows Uint8Array<ArrayBufferLike> too aggressively for
      // BodyInit; runtime accepts the bytes fine.
      body: signed.body as RequestInit['body'],
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: `S3 fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'fetch_failed',
    });
    return;
  }

  const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
  res.json({
    ok: true,
    status: upstream.status,
    headers: passthroughHeaders(upstream),
    bodyBase64: encodeBase64(upstreamBody),
  });
}

/**
 * Handle a `POST /api/da-sign-and-forward` request. Attaches the IMS bearer
 * token (passed transiently in the envelope), forwards to da.live, returns
 * a JSON envelope.
 *
 * v1: the IMS token comes from the browser at request time. The browser
 * already holds the token via the existing Adobe LLM provider OAuth flow;
 * routing through the server gives architectural symmetry with S3 and a
 * place to tighten the threat model in v2 (server-side OAuth).
 */
export async function handleDaSignAndForward(req: Request, res: Response): Promise<void> {
  const env = req.body as Partial<DaSignAndForwardEnvelope> | undefined;

  if (typeof env?.imsToken !== 'string' || env.imsToken.length === 0) {
    res.status(400).json({
      ok: false,
      error: 'imsToken is required',
      errorCode: 'invalid_request',
    });
    return;
  }
  if (!isAllowedMethod(env.method)) {
    res.status(400).json({ ok: false, error: 'invalid method', errorCode: 'invalid_request' });
    return;
  }
  if (typeof env.path !== 'string' || !env.path.startsWith('/')) {
    res.status(400).json({
      ok: false,
      error: 'path must be a string starting with /',
      errorCode: 'invalid_request',
    });
    return;
  }

  let url: URL;
  try {
    url = new URL(DA_ORIGIN + env.path);
    if (env.query) {
      for (const [k, v] of Object.entries(env.query)) {
        url.searchParams.set(k, v);
      }
    }
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : 'failed to build URL',
      errorCode: 'invalid_request',
    });
    return;
  }

  const body =
    typeof env.bodyBase64 === 'string' && env.bodyBase64.length > 0
      ? decodeBase64(env.bodyBase64)
      : undefined;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url.toString(), {
      method: env.method,
      headers: {
        ...(env.headers ?? {}),
        Authorization: `Bearer ${env.imsToken}`,
      },
      // Cast: TS 6 narrows Uint8Array<ArrayBufferLike> too aggressively for
      // BodyInit; runtime accepts the bytes fine.
      body: body as RequestInit['body'],
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: `DA fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'fetch_failed',
    });
    return;
  }

  const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
  res.json({
    ok: true,
    status: upstream.status,
    headers: passthroughHeaders(upstream),
    bodyBase64: encodeBase64(upstreamBody),
  });
}
