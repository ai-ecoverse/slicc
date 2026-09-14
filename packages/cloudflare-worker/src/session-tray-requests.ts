import type {
  FollowerBootstrapRequest,
  TrayIceCandidate,
  TraySessionDescription,
} from '@slicc/shared-ts';

export interface ControllerAttachRequest {
  controllerId?: string;
  leaderKey?: string;
  runtime?: string;
}

export type JoinRequest = ControllerAttachRequest | FollowerBootstrapRequest;

interface FollowerBootstrapBody {
  action?: unknown;
  controllerId?: unknown;
  bootstrapId?: unknown;
  runtime?: unknown;
  cursor?: unknown;
  answer?: unknown;
  candidate?: unknown;
}

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

export function buildLeaderWebSocketUrl(url: URL, controllerId: string, leaderKey: string): string {
  const webSocketUrl = new URL(
    url.pathname,
    `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
  );
  webSocketUrl.searchParams.set('controllerId', controllerId);
  webSocketUrl.searchParams.set('leaderKey', leaderKey);
  return webSocketUrl.toString();
}
