import { base64ToUint8, uint8ToBase64 } from './base64.js';
import { signSigV4 } from './sigv4.js';

const ALLOWED_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'] as const;
type SignedMethod = (typeof ALLOWED_METHODS)[number];

const PROFILE_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

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

const DA_ORIGIN = 'https://admin.da.live';

const DA_ALLOWED_ORIGINS = new Set([DA_ORIGIN, 'https://api.aem.live']);

export interface S3SignAndForwardEnvelope {
  profile: string;
  method: SignedMethod;
  bucket: string;
  key: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyBase64?: string | null;
}

export interface DaSignAndForwardEnvelope {
  imsToken: string;
  method: SignedMethod;

  path: string;

  origin?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyBase64?: string | null;
}

export type SignAndForwardErrorCode =
  | 'invalid_profile'
  | 'invalid_request'
  | 'profile_not_configured'
  | 'fetch_failed'
  | 'internal';

export interface SignAndForwardSuccess {
  ok: true;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

export interface SignAndForwardFailure {
  ok: false;
  error: string;
  errorCode: SignAndForwardErrorCode;
}

export type SignAndForwardReply = SignAndForwardSuccess | SignAndForwardFailure;

export interface SecretGetter {
  get(key: string): Promise<string | undefined>;
}

interface S3Profile {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  endpoint?: string;
  pathStyle: boolean;
}

function isAllowedMethod(m: unknown): m is SignedMethod {
  return typeof m === 'string' && (ALLOWED_METHODS as readonly string[]).includes(m);
}

class ProfileNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileNotConfiguredError';
  }
}

async function resolveS3Profile(name: string, store: SecretGetter): Promise<S3Profile> {
  const accessKeyId = await store.get(`s3.${name}.access_key_id`);
  const secretAccessKey = await store.get(`s3.${name}.secret_access_key`);

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
    sessionToken: await store.get(`s3.${name}.session_token`),
    region: (await store.get(`s3.${name}.region`)) ?? 'us-east-1',
    endpoint: await store.get(`s3.${name}.endpoint`),
    pathStyle: (await store.get(`s3.${name}.path_style`)) === 'true',
  };
}

function buildS3Url(
  profile: S3Profile,
  bucket: string,
  key: string,
  query?: Record<string, string>
): URL {
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

function passthroughHeaders(upstream: Response): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}

export async function executeS3SignAndForward(
  env: Partial<S3SignAndForwardEnvelope> | undefined,
  store: SecretGetter,
  fetchImpl: typeof fetch = fetch
): Promise<SignAndForwardReply> {
  if (
    typeof env?.profile !== 'string' ||
    env.profile.length === 0 ||
    !PROFILE_NAME_REGEX.test(env.profile)
  ) {
    return {
      ok: false,
      error: 'invalid profile name (allowed: alphanumeric, dot, underscore, hyphen)',
      errorCode: 'invalid_profile',
    };
  }
  if (!isAllowedMethod(env.method)) {
    return { ok: false, error: 'invalid method', errorCode: 'invalid_request' };
  }
  if (typeof env.bucket !== 'string' || env.bucket.length === 0) {
    return { ok: false, error: 'invalid bucket', errorCode: 'invalid_request' };
  }
  if (typeof env.key !== 'string') {
    return { ok: false, error: 'invalid key', errorCode: 'invalid_request' };
  }

  let profile: S3Profile;
  try {
    profile = await resolveS3Profile(env.profile, store);
  } catch (err) {
    if (err instanceof ProfileNotConfiguredError) {
      return { ok: false, error: err.message, errorCode: 'profile_not_configured' };
    }
    throw err;
  }

  let url: URL;
  try {
    url = buildS3Url(profile, env.bucket, env.key, env.query);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'failed to build URL',
      errorCode: 'invalid_request',
    };
  }

  const body =
    typeof env.bodyBase64 === 'string' && env.bodyBase64.length > 0
      ? base64ToUint8(env.bodyBase64)
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

  let upstream: Response;
  try {
    upstream = await fetchImpl(url.toString(), {
      method: signed.method,
      headers: signed.headers,
      body: signed.body as RequestInit['body'],
    });
  } catch (err) {
    return {
      ok: false,
      error: `S3 fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'fetch_failed',
    };
  }

  const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
  return {
    ok: true,
    status: upstream.status,
    headers: passthroughHeaders(upstream),
    bodyBase64: uint8ToBase64(upstreamBody),
  };
}

export async function executeDaSignAndForward(
  env: Partial<DaSignAndForwardEnvelope> | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<SignAndForwardReply> {
  if (typeof env?.imsToken !== 'string' || env.imsToken.length === 0) {
    return { ok: false, error: 'imsToken is required', errorCode: 'invalid_request' };
  }
  if (!isAllowedMethod(env.method)) {
    return { ok: false, error: 'invalid method', errorCode: 'invalid_request' };
  }
  if (typeof env.path !== 'string' || !env.path.startsWith('/')) {
    return {
      ok: false,
      error: 'path must be a string starting with /',
      errorCode: 'invalid_request',
    };
  }

  const origin = env.origin ?? DA_ORIGIN;
  if (!DA_ALLOWED_ORIGINS.has(origin)) {
    return {
      ok: false,
      error: `origin '${origin}' is not an allowed DA upstream`,
      errorCode: 'invalid_request',
    };
  }

  let url: URL;
  try {
    url = new URL(origin + env.path);
    if (env.query) {
      for (const [k, v] of Object.entries(env.query)) {
        url.searchParams.set(k, v);
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'failed to build URL',
      errorCode: 'invalid_request',
    };
  }

  const body =
    typeof env.bodyBase64 === 'string' && env.bodyBase64.length > 0
      ? base64ToUint8(env.bodyBase64)
      : undefined;

  let upstream: Response;
  try {
    upstream = await fetchImpl(url.toString(), {
      method: env.method,
      headers: {
        ...(env.headers ?? {}),
        Authorization: `Bearer ${env.imsToken}`,
      },
      body: body as RequestInit['body'],
    });
  } catch (err) {
    return {
      ok: false,
      error: `DA fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'fetch_failed',
    };
  }

  const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
  return {
    ok: true,
    status: upstream.status,
    headers: passthroughHeaders(upstream),
    bodyBase64: uint8ToBase64(upstreamBody),
  };
}
