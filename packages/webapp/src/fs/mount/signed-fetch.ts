import { base64ToUint8, type SignAndForwardReply, uint8ToBase64 } from '@slicc/shared-ts';
import type { CapabilityAdapterId, MountSignRequest } from '../../work-unit/capability/index.js';
import { FsError } from '../types.js';
import type { SignedFetchDa, SignedFetchDaRequest } from './backend-da.js';
import type { SignedFetchS3, SignedFetchS3Request } from './backend-s3.js';
import { getMountCapabilityBroker } from './capability-broker.js';
import { getDefaultImsClient } from './profile.js';

const decodeBase64 = base64ToUint8;
const encodeBase64 = uint8ToBase64;

const KNOWN_ERROR_CODES = new Set([
  'invalid_profile',
  'invalid_request',
  'profile_not_configured',
  'fetch_failed',
  'internal',
]);

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

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
    throw new FsError(
      'EIO',
      `mount transport: response body decode failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const responseBody: BlobPart | null = NULL_BODY_STATUSES.has(reply.status)
    ? null
    : (body as BlobPart);
  return new Response(responseBody, {
    status: reply.status,
    headers: new Headers(reply.headers),
  });
}

function transportHint(adapter: CapabilityAdapterId, status: number | undefined): string {
  if (status !== undefined) return '';
  if (adapter === 'node-rest') return ' (SLICC backend at localhost may not be running)';
  if (adapter === 'extension-direct' || adapter === 'extension-delegate') {
    return ' (extension service worker not responding)';
  }
  return '';
}

async function sendSignRequest(request: MountSignRequest): Promise<SignAndForwardReply> {
  const broker = getMountCapabilityBroker();
  if (!broker) {
    throw new FsError(
      'EIO',
      'mount transport unavailable: setMountCapabilityBroker was never called for this ' +
        'float (composition bug — refusing to guess a transport for a privileged ' +
        'sign-and-forward request)'
    );
  }
  const result = await broker.mounts.signRequest(request);
  if (!result.ok) {
    const status = 'status' in result ? result.status : undefined;
    throw new FsError(
      'EIO',
      `mount transport failed: ${result.message}${transportHint(broker.adapter, status)}`
    );
  }
  return result.value;
}

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
