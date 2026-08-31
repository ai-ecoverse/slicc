/**
 * Request parsing and wire-shape guards for the tray durable object.
 *
 * Everything here is PURE — no tray record, no leader socket, no storage. That
 * is the point: these are the functions that turn an untrusted `Request` (or a
 * loosely-typed body that already crossed the wire) into a narrow, validated
 * shape, and they should be readable and testable without a DO harness.
 *
 * The guards deliberately re-validate fields the leader "already checked": the
 * DO is the trust boundary for what it stores and relays, so a shape that only
 * a well-behaved client would produce is never assumed.
 */

import type {
  FollowerBootstrapRequest,
  TrayIceCandidate,
  TraySessionDescription,
} from '@slicc/shared-ts';

/** Query/body shape for `POST /controller/:token` and the plain follower attach. */
export interface ControllerAttachRequest {
  controllerId?: string;
  leaderKey?: string;
  runtime?: string;
}

/** Either a plain attach or one of the WebRTC bootstrap signaling actions. */
export type JoinRequest = ControllerAttachRequest | FollowerBootstrapRequest;

/** Loosely-typed follower bootstrap POST body; every field is re-validated below. */
interface FollowerBootstrapBody {
  action?: unknown;
  controllerId?: unknown;
  bootstrapId?: unknown;
  runtime?: unknown;
  cursor?: unknown;
  answer?: unknown;
  candidate?: unknown;
}

/**
 * Bootstrap signaling body → a narrowed {@link FollowerBootstrapRequest}, or
 * `null` when `action` is not one of the four signaling verbs (i.e. this is a
 * plain attach). Split out of {@link readJoinRequest} so that function stays a
 * short "where do the fields come from" reader.
 */
function bootstrapRequestFromBody(
  body: FollowerBootstrapBody,
  controllerId: string | undefined,
  bootstrapId: string | undefined,
  runtime: string | undefined
): FollowerBootstrapRequest | null {
  switch (body.action) {
    case 'poll':
      return {
        action: 'poll',
        controllerId,
        bootstrapId,
        cursor: typeof body.cursor === 'number' ? body.cursor : undefined,
      };
    case 'answer':
      return {
        action: 'answer',
        controllerId,
        bootstrapId,
        answer: body.answer as TraySessionDescription | undefined,
      };
    case 'ice-candidate':
      return {
        action: 'ice-candidate',
        controllerId,
        bootstrapId,
        candidate: body.candidate as TrayIceCandidate | undefined,
      };
    case 'retry':
      return { action: 'retry', controllerId, bootstrapId, runtime };
    default:
      return null;
  }
}

/**
 * Read a `/join/:token` request. Query parameters are the floor; a JSON POST
 * body overrides them. A body that is missing, non-JSON or malformed degrades
 * to the query-only attach rather than failing the join — the follower's first
 * contact should not hinge on a body it may not have sent.
 */
export async function readJoinRequest(request: Request, url: URL): Promise<JoinRequest> {
  const queryAttach: ControllerAttachRequest = {
    controllerId: url.searchParams.get('controllerId') ?? undefined,
    runtime: url.searchParams.get('runtime') ?? undefined,
  };

  if (request.method !== 'POST') {
    return queryAttach;
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return queryAttach;
  }

  try {
    const body = (await request.json()) as FollowerBootstrapBody;
    const controllerId =
      typeof body.controllerId === 'string' ? body.controllerId : queryAttach.controllerId;
    const bootstrapId = typeof body.bootstrapId === 'string' ? body.bootstrapId : undefined;
    const runtime = typeof body.runtime === 'string' ? body.runtime : queryAttach.runtime;

    return (
      bootstrapRequestFromBody(body, controllerId, bootstrapId, runtime) ?? {
        controllerId,
        runtime,
      }
    );
  } catch {
    return queryAttach;
  }
}

/** Same query-then-body reading for the controller attach route. */
export async function readAttachRequest(
  request: Request,
  url: URL
): Promise<ControllerAttachRequest> {
  const queryAttach: ControllerAttachRequest = {
    controllerId: url.searchParams.get('controllerId') ?? undefined,
    leaderKey: url.searchParams.get('leaderKey') ?? undefined,
    runtime: url.searchParams.get('runtime') ?? undefined,
  };

  if (request.method !== 'POST') {
    return queryAttach;
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return queryAttach;
  }

  try {
    const body = (await request.json()) as ControllerAttachRequest;
    return {
      controllerId: body.controllerId ?? queryAttach.controllerId,
      leaderKey: body.leaderKey ?? queryAttach.leaderKey,
      runtime: body.runtime ?? queryAttach.runtime,
    };
  } catch {
    return queryAttach;
  }
}

export function isBootstrapRequest(request: JoinRequest): request is FollowerBootstrapRequest {
  return 'action' in request;
}

/** The request's controller id, or a fresh one so an error response can still name a controller. */
export function joinRequestControllerId(request: JoinRequest): string {
  return request.controllerId ?? crypto.randomUUID();
}

export function isSessionDescription(
  value: TraySessionDescription | undefined,
  expectedType: TraySessionDescription['type']
): value is TraySessionDescription {
  return Boolean(value && value.type === expectedType && typeof value.sdp === 'string');
}

export function isIceCandidate(value: TrayIceCandidate | undefined): value is TrayIceCandidate {
  return Boolean(value && typeof value.candidate === 'string');
}

/** The `wss://` form of the controller route, carrying the leader's credentials as query params. */
export function buildLeaderWebSocketUrl(url: URL, controllerId: string, leaderKey: string): string {
  const webSocketUrl = new URL(
    url.pathname,
    `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
  );
  webSocketUrl.searchParams.set('controllerId', controllerId);
  webSocketUrl.searchParams.set('leaderKey', leaderKey);
  return webSocketUrl.toString();
}
