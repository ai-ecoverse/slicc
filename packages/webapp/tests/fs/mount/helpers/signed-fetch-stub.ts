import { signSigV4 } from '@slicc/shared-ts';
import type { SignedFetchDa, SignedFetchDaRequest } from '../../../../src/fs/mount/backend-da.js';
import type { SignedFetchS3, SignedFetchS3Request } from '../../../../src/fs/mount/backend-s3.js';
import type { DaProfile, S3Profile } from '../../../../src/fs/mount/profile.js';

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

export function createSignedFetchDaStub(
  profile: DaProfile,
  apiBase: string = 'https://admin.da.live'
): SignedFetchDa {
  return async (req: SignedFetchDaRequest): Promise<Response> => {
    const url = new URL((req.origin ?? apiBase) + req.path);
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
