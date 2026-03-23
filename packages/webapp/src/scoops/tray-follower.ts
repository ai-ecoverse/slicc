import { createLogger } from '../core/logger.js';
import type {
  FollowerAttachResponse,
  FollowerBootstrapResponse,
  FollowerJoinRequest,
  TrayLeaderSummary,
  TrayBootstrapEvent,
  TrayBootstrapStatus,
  TrayIceCandidate,
  TraySessionDescription,
  TurnIceServer,
} from './tray-types.js';

const log = createLogger('tray-follower');

export interface FollowerAttachOptions extends FollowerJoinRequest {
  joinUrl: string;
  fetchImpl?: typeof fetch;
}

export interface FollowerAttachPlan {
  trayId: string;
  controllerId: string;
  participantCount: number;
  leader: TrayLeaderSummary | null;
  action: 'wait' | 'signal' | 'fail';
  code: string;
  retryAfterMs?: number;
  error?: string;
  bootstrap?: TrayBootstrapStatus;
  iceServers?: TurnIceServer[];
}

export interface FollowerBootstrapOptions {
  joinUrl: string;
  controllerId: string;
  bootstrapId: string;
  cursor?: number;
  runtime?: string;
  fetchImpl?: typeof fetch;
}

export interface FollowerBootstrapPlan {
  trayId: string;
  controllerId: string;
  participantCount: number;
  leader: TrayLeaderSummary | null;
  bootstrap: TrayBootstrapStatus;
  events: TrayBootstrapEvent[];
}

export async function attachTrayFollower(
  options: FollowerAttachOptions
): Promise<FollowerAttachPlan> {
  const response = await (options.fetchImpl ?? fetch)(options.joinUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      controllerId: options.controllerId,
      runtime: options.runtime,
    }),
  });

  const body = await readFollowerAttachResponse(response);
  log.info('Follower tray attach response', {
    trayId: body.trayId,
    action: body.result.action,
    code: body.result.code,
    participantCount: body.participantCount,
  });
  return normalizeFollowerAttachResponse(body);
}

export function normalizeFollowerAttachResponse(
  response: FollowerAttachResponse
): FollowerAttachPlan {
  const base = {
    trayId: response.trayId,
    controllerId: response.controllerId,
    participantCount: response.participantCount,
    leader: response.leader,
    action: response.result.action,
    code: response.result.code,
    iceServers: response.iceServers,
  } as const;

  if (response.result.action === 'wait') {
    return { ...base, retryAfterMs: response.result.retryAfterMs };
  }
  if (response.result.action === 'signal') {
    return { ...base, bootstrap: response.result.bootstrap };
  }
  if (response.result.action === 'fail') {
    return { ...base, error: response.result.error };
  }
  return base;
}

export async function pollTrayFollowerBootstrap(
  options: FollowerBootstrapOptions
): Promise<FollowerBootstrapPlan> {
  return normalizeFollowerBootstrapResponse(
    await postFollowerBootstrapRequest(options, {
      action: 'poll',
      controllerId: options.controllerId,
      bootstrapId: options.bootstrapId,
      cursor: options.cursor,
    })
  );
}

export async function sendTrayFollowerAnswer(
  options: FollowerBootstrapOptions & { answer: TraySessionDescription }
): Promise<FollowerBootstrapPlan> {
  return normalizeFollowerBootstrapResponse(
    await postFollowerBootstrapRequest(options, {
      action: 'answer',
      controllerId: options.controllerId,
      bootstrapId: options.bootstrapId,
      answer: options.answer,
    })
  );
}

export async function sendTrayFollowerIceCandidate(
  options: FollowerBootstrapOptions & { candidate: TrayIceCandidate }
): Promise<FollowerBootstrapPlan> {
  return normalizeFollowerBootstrapResponse(
    await postFollowerBootstrapRequest(options, {
      action: 'ice-candidate',
      controllerId: options.controllerId,
      bootstrapId: options.bootstrapId,
      candidate: options.candidate,
    })
  );
}

export async function retryTrayFollowerBootstrap(
  options: FollowerBootstrapOptions
): Promise<FollowerBootstrapPlan> {
  return normalizeFollowerBootstrapResponse(
    await postFollowerBootstrapRequest(options, {
      action: 'retry',
      controllerId: options.controllerId,
      bootstrapId: options.bootstrapId,
      runtime: options.runtime,
    })
  );
}

export function normalizeFollowerBootstrapResponse(
  response: FollowerBootstrapResponse
): FollowerBootstrapPlan {
  return {
    trayId: response.trayId,
    controllerId: response.controllerId,
    participantCount: response.participantCount,
    leader: response.leader,
    bootstrap: response.bootstrap,
    events: response.events,
  };
}

async function readFollowerAttachResponse(response: Response): Promise<FollowerAttachResponse> {
  let rawText: string | null = null;
  let payload: unknown = null;
  try {
    rawText = await response.text();
    payload = JSON.parse(rawText);
  } catch {
    // payload stays null — validation below will throw
  }
  if (!isFollowerAttachResponse(payload)) {
    const preview = rawText ? rawText.slice(0, 200) : '(empty)';
    log.warn('Tray follower attach returned an invalid response', {
      status: response.status,
      body: preview,
    });
    throw new Error(
      `Tray follower attach returned an invalid response (${response.status}): ${preview}`
    );
  }
  return payload;
}

async function postFollowerBootstrapRequest(
  options: FollowerBootstrapOptions,
  body: Record<string, unknown>
): Promise<FollowerBootstrapResponse> {
  const response = await (options.fetchImpl ?? fetch)(options.joinUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!isFollowerBootstrapResponse(payload)) {
    throw new Error(`Tray follower bootstrap returned an invalid response (${response.status})`);
  }
  return payload;
}

function isFollowerAttachResponse(value: unknown): value is FollowerAttachResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const response = value as Record<string, unknown>;
  if (
    typeof response['trayId'] !== 'string' ||
    typeof response['controllerId'] !== 'string' ||
    response['role'] !== 'follower' ||
    typeof response['participantCount'] !== 'number'
  ) {
    return false;
  }

  const result = response['result'];
  if (!result || typeof result !== 'object') {
    return false;
  }

  const attachResult = result as Record<string, unknown>;
  if (attachResult['action'] === 'wait') {
    return (
      (attachResult['code'] === 'LEADER_NOT_ELECTED' ||
        attachResult['code'] === 'LEADER_NOT_CONNECTED') &&
      typeof attachResult['retryAfterMs'] === 'number'
    );
  }
  if (attachResult['action'] === 'signal') {
    return (
      attachResult['code'] === 'LEADER_CONNECTED' &&
      isTrayBootstrapStatus(attachResult['bootstrap'])
    );
  }
  if (attachResult['action'] === 'fail') {
    return (
      (attachResult['code'] === 'INVALID_JOIN_CAPABILITY' ||
        attachResult['code'] === 'TRAY_EXPIRED') &&
      typeof attachResult['error'] === 'string'
    );
  }

  return false;
}

function isFollowerBootstrapResponse(value: unknown): value is FollowerBootstrapResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const response = value as Record<string, unknown>;
  return (
    typeof response['trayId'] === 'string' &&
    typeof response['controllerId'] === 'string' &&
    response['role'] === 'follower' &&
    typeof response['participantCount'] === 'number' &&
    isTrayBootstrapStatus(response['bootstrap']) &&
    Array.isArray(response['events'])
  );
}

function isTrayBootstrapStatus(value: unknown): value is TrayBootstrapStatus {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const status = value as Record<string, unknown>;
  return (
    typeof status['controllerId'] === 'string' &&
    typeof status['bootstrapId'] === 'string' &&
    typeof status['attempt'] === 'number' &&
    typeof status['state'] === 'string' &&
    typeof status['expiresAt'] === 'string' &&
    typeof status['cursor'] === 'number' &&
    typeof status['maxRetries'] === 'number' &&
    typeof status['retriesRemaining'] === 'number'
  );
}
