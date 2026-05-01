/**
 * Test helpers for the new injected `SignedFetchS3` / `SignedFetchDa`
 * transport seam. Each helper mirrors the production wire shape (URL,
 * Authorization header, body bytes) but signs locally with a fake profile
 * and routes through whatever `fetch` is on `globalThis`. Tests that
 * previously installed a `globalThis.fetch` mock keep working unchanged
 * — they assert on the same wire-level shape.
 */

import { signSigV4 } from '../../../../src/fs/mount/signing-s3.js';
import type { SignedFetchS3, SignedFetchS3Request } from '../../../../src/fs/mount/backend-s3.js';
import type { SignedFetchDa, SignedFetchDaRequest } from '../../../../src/fs/mount/backend-da.js';
import type { S3Profile, DaProfile } from '../../../../src/fs/mount/profile.js';

/**
 * Build an in-memory `SignedFetchS3` that mirrors the server-side flow:
 * construct the upstream S3 URL from the profile, sign with SigV4 v4, and
 * call `globalThis.fetch` (which tests typically have mocked).
 */
export function createSignedFetchS3Stub(
  profile: S3Profile & { pathStyle?: boolean }
): SignedFetchS3 {
  return async (req: SignedFetchS3Request): Promise<Response> => {
    const host = profile.endpoint
      ? new URL(profile.endpoint).host
      : `s3.${profile.region}.amazonaws.com`;
    const encKey = req.key
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const encBucket = encodeURIComponent(req.bucket);
    const pathPart = profile.pathStyle ? `${encBucket}/${encKey}` : encKey;
    const hostPart = profile.pathStyle ? host : `${encBucket}.${host}`;
    const url = new URL(`https://${hostPart}/${pathPart}`);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        url.searchParams.set(k, v);
      }
    }

    const signed = await signSigV4(
      {
        method: req.method,
        url,
        headers: { ...(req.headers ?? {}), Host: url.host },
        body: req.body,
      },
      {
        accessKeyId: profile.accessKeyId,
        secretAccessKey: profile.secretAccessKey,
        sessionToken: profile.sessionToken,
      },
      profile.region,
      's3'
    );
    return fetch(url.toString(), {
      method: signed.method,
      headers: signed.headers,
      body: signed.body as RequestInit['body'],
    });
  };
}

/**
 * Build an in-memory `SignedFetchDa` that mirrors the server-side flow:
 * prepend `https://admin.da.live` to the path, attach the bearer token,
 * call `globalThis.fetch`.
 *
 * `apiBase` defaults to `https://admin.da.live`; tests override it to
 * pin URL assertions to a custom origin (e.g. when the existing test
 * suite was written against `https://da.test.example`).
 */
export function createSignedFetchDaStub(
  profile: DaProfile,
  apiBase: string = 'https://admin.da.live'
): SignedFetchDa {
  return async (req: SignedFetchDaRequest): Promise<Response> => {
    const url = new URL(apiBase + req.path);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        url.searchParams.set(k, v);
      }
    }
    const token = await profile.getBearerToken();
    const headers = {
      ...(req.headers ?? {}),
      authorization: `Bearer ${token}`,
    };
    return fetch(url.toString(), {
      method: req.method,
      headers,
      body: req.body as RequestInit['body'],
    });
  };
}
