/**
 * Default `SignedFetch` factories, routed through the `CapabilityBroker`'s
 * `mounts.signRequest` op (#2276 slice C).
 *
 * The browser-side mount backends never compute SigV4 signatures or hold
 * S3 credentials. They build a logical envelope and hand it to the broker,
 * which picks the transport for this float's topology — HTTP POST to
 * node-server's `/api/s3-sign-and-forward` / `/api/da-sign-and-forward`
 * (`node-rest`), or a `chrome.runtime` message to the extension service
 * worker (`extension-direct` / `extension-delegate`). Every adapter already
 * implements `mounts.signRequest` (slice B), so this module holds no
 * topology branch of its own — see `getMountCapabilityBroker` below.
 *
 * For DA, the IMS bearer token is fetched from the existing Adobe LLM
 * provider's browser-side state and passed transiently in the envelope. v2
 * will move OAuth server/SW-side and remove the browser-side exposure.
 */

import { base64ToUint8, type SignAndForwardReply, uint8ToBase64 } from '@slicc/shared-ts';
import type { MountSignRequest } from '../../work-unit/capability/index.js';
import { FsError } from '../types.js';
import type { SignedFetchDa, SignedFetchDaRequest } from './backend-da.js';
import type { SignedFetchS3, SignedFetchS3Request } from './backend-s3.js';
import { getMountCapabilityBroker } from './capability-broker.js';
import { getDefaultImsClient } from './profile.js';

const decodeBase64 = base64ToUint8;
const encodeBase64 = uint8ToBase64;

/**
 * The set of `errorCode` values the orchestrator can return. Kept in sync
 * with `SignAndForwardErrorCode` in `@slicc/shared-ts`. If the
 * server adds a new code that isn't listed here, `envelopeToResponse`
 * surfaces `EINVAL` with the raw text rather than silently mapping to
 * `EIO` — that way the new code is debuggable.
 */
const KNOWN_ERROR_CODES = new Set([
  'invalid_profile',
  'invalid_request',
  'profile_not_configured',
  'fetch_failed',
  'internal',
]);

/**
 * HTTP statuses for which the WHATWG `Response` constructor refuses any
 * body argument (including a 0-byte Uint8Array) — the spec calls these
 * "null body statuses". DA returns 204 for DELETE, 205 is rare but
 * legal, 304 is the conditional-GET reuse path. Passing a body for any
 * of these throws `TypeError: Response with null body status cannot
 * have body`.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Convert envelope-level errors into `FsError` so the backend can surface them uniformly. */
function envelopeToResponse(reply: SignAndForwardReply): Response {
  if (!reply.ok) {
    if (reply.errorCode === 'profile_not_configured' || reply.errorCode === 'invalid_profile') {
      throw new FsError('EACCES', reply.error);
    }
    if (reply.errorCode === 'invalid_request') {
      throw new FsError('EINVAL', reply.error);
    }
    if (reply.errorCode === 'fetch_failed') {
      throw new FsError('EIO', reply.error);
    }
    if (reply.errorCode === 'internal') {
      throw new FsError('EIO', reply.error);
    }
    // Unknown / undefined errorCode — surface as EINVAL so the unfamiliar
    // shape is visible to the agent rather than masquerading as a network
    // failure. Includes the raw code in the message for debugging.
    if (!KNOWN_ERROR_CODES.has(String(reply.errorCode))) {
      throw new FsError(
        'EINVAL',
        `mount transport returned unrecognized errorCode '${reply.errorCode}': ${reply.error}`
      );
    }
    throw new FsError('EIO', reply.error);
  }
  let body: Uint8Array;
  try {
    body = decodeBase64(reply.bodyBase64);
  } catch (err) {
    // Malformed base64 in a successful envelope = transport corruption
    // (oversized payload truncated at chrome.runtime boundary, partial
    // HTTP response, etc.). Surface as EIO with a message that points at
    // the boundary rather than an opaque DOMException.
    throw new FsError(
      'EIO',
      `mount transport: response body decode failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  // For null-body statuses (204, 205, 304, 101, 103) the Response
  // constructor refuses any body argument, even a 0-byte Uint8Array.
  // Pass null instead. This is the path for successful DELETE (204)
  // and Reset Content (205); 304 also flows here when an upstream cache
  // hit happens to bubble all the way through the transport.
  const responseBody: BlobPart | null = NULL_BODY_STATUSES.has(reply.status)
    ? null
    : (body as BlobPart);
  return new Response(responseBody, {
    status: reply.status,
    headers: new Headers(reply.headers),
  });
}

/**
 * Send one `MountSignRequest` through the injected broker and unwrap it.
 *
 * `CapabilityResult.ok: false` here means the TRANSPORT failed (no adapter,
 * a disconnected Port, an unparseable reply) — a server-side refusal
 * (`profile_not_configured`, `invalid_request`, …) travels as a normal
 * `SignAndForwardReply` with `ok: false` INSIDE a successful
 * `CapabilityResult`, exactly as it did when this module built the HTTP/SW
 * request itself; `envelopeToResponse` still does that error-code mapping.
 */
async function sendSignRequest(request: MountSignRequest): Promise<SignAndForwardReply> {
  const result = await getMountCapabilityBroker().mounts.signRequest(request);
  if (!result.ok) {
    throw new FsError('EIO', `mount transport failed: ${result.message}`);
  }
  return result.value;
}

// ----------------- S3 -----------------

/**
 * Build an S3 transport bound to a specific profile name. Used by mount
 * construction sites — each backend instance gets its own bound transport.
 */
export function makeSignedFetchS3(profile: string): SignedFetchS3 {
  return async (req: SignedFetchS3Request): Promise<Response> => {
    const envelope = {
      profile,
      method: req.method,
      bucket: req.bucket,
      key: req.key,
      query: req.query,
      headers: req.headers,
      bodyBase64: req.body ? encodeBase64(req.body) : undefined,
    };
    const reply = await sendSignRequest({ backend: 's3', envelope });
    return envelopeToResponse(reply);
  };
}

// ----------------- DA -----------------

/**
 * Build a DA transport. Fetches the IMS token from the existing Adobe LLM
 * provider state at each call (so token refreshes naturally apply).
 *
 * Optional `getImsToken` override is for tests; production reads via
 * `getDefaultImsClient()` from `profile.ts`.
 */
export function makeSignedFetchDa(opts?: { getImsToken?: () => Promise<string> }): SignedFetchDa {
  const getToken =
    opts?.getImsToken ?? (async () => (await getDefaultImsClient()).getBearerToken());
  return async (req: SignedFetchDaRequest): Promise<Response> => {
    let imsToken: string;
    try {
      imsToken = await getToken();
    } catch (err) {
      throw new FsError('EACCES', `DA mount: ${err instanceof Error ? err.message : String(err)}`);
    }
    const envelope = {
      imsToken,
      method: req.method,
      path: req.path,
      origin: req.origin,
      query: req.query,
      headers: req.headers,
      bodyBase64: req.body ? encodeBase64(req.body) : undefined,
    };
    const reply = await sendSignRequest({ backend: 'da', envelope });
    return envelopeToResponse(reply);
  };
}
