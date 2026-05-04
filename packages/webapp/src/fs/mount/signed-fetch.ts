/**
 * Default `SignedFetch` factories — pick CLI vs extension transport at runtime.
 *
 * The browser-side mount backends never compute SigV4 signatures or hold
 * S3 credentials. They build logical requests and call into a `signedFetch`
 * function which routes:
 *
 *   - **CLI / Electron**: HTTP POST to node-server's
 *     `/api/s3-sign-and-forward` or `/api/da-sign-and-forward` (relative URL,
 *     same origin). Server resolves credentials, signs, forwards.
 *   - **Extension**: `chrome.runtime.sendMessage` to the service worker.
 *     Service worker reads `s3.<profile>.*` from `chrome.storage.local`
 *     (S3) or accepts a transient IMS token in the envelope (DA), then
 *     signs/attaches and forwards via `fetch` (host_permissions: <all_urls>).
 *
 * For DA in either deployment, the IMS bearer token is fetched from the
 * existing Adobe LLM provider's browser-side state and passed transiently
 * in the envelope. v2 will move OAuth server/SW-side and remove the
 * browser-side exposure.
 */

import { getDefaultImsClient } from './profile.js';
import type { SignedFetchDa, SignedFetchDaRequest } from './backend-da.js';
import type { SignedFetchS3, SignedFetchS3Request } from './backend-s3.js';
import type { SignAndForwardReply } from './sign-and-forward-shared.js';
import { FsError } from '../types.js';

function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!(chrome as unknown as { runtime?: { id?: string } })?.runtime?.id
  );
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * The set of `errorCode` values the orchestrator can return. Kept in sync
 * with `SignAndForwardErrorCode` in `sign-and-forward-shared.ts`. If the
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
  return new Response(body as BlobPart, {
    status: reply.status,
    headers: new Headers(reply.headers),
  });
}

/** POST an envelope to node-server's sign-and-forward endpoint, parse reply. */
async function postEnvelopeToCli(endpoint: string, body: unknown): Promise<SignAndForwardReply> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new FsError(
      'EIO',
      `mount transport failed: ${err instanceof Error ? err.message : String(err)} ` +
        `(SLICC backend at localhost may not be running)`
    );
  }
  // Parse the body — server returns the same envelope shape on both success
  // (200) and structured error (400/502). If the server crashes outside the
  // route handler (e.g. middleware error producing Express's default HTML
  // error page), .json() throws a SyntaxError. Map to FsError so the agent
  // sees an actionable transport message rather than an opaque parse error.
  try {
    return (await res.json()) as SignAndForwardReply;
  } catch (err) {
    throw new FsError(
      'EIO',
      `mount transport: response is not a JSON envelope (status ${res.status}): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Post a chrome.runtime message to the SW and await the response. */
async function postEnvelopeToSw(
  type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward',
  envelope: unknown
): Promise<SignAndForwardReply> {
  try {
    // The bundled chrome.d.ts declares sendMessage's return as Promise<void>;
    // Chrome MV3's actual API resolves with whatever the listener
    // sendResponse'd. Cast through unknown to land on the typed envelope.
    const raw = (await chrome.runtime.sendMessage({ type, envelope })) as unknown;
    return raw as SignAndForwardReply;
  } catch (err) {
    throw new FsError(
      'EIO',
      `mount transport failed: ${err instanceof Error ? err.message : String(err)} ` +
        `(extension service worker not responding)`
    );
  }
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
    const reply = isExtensionContext()
      ? await postEnvelopeToSw('mount.s3-sign-and-forward', envelope)
      : await postEnvelopeToCli('/api/s3-sign-and-forward', envelope);
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
      query: req.query,
      headers: req.headers,
      bodyBase64: req.body ? encodeBase64(req.body) : undefined,
    };
    const reply = isExtensionContext()
      ? await postEnvelopeToSw('mount.da-sign-and-forward', envelope)
      : await postEnvelopeToCli('/api/da-sign-and-forward', envelope);
    return envelopeToResponse(reply);
  };
}
