import type {
  FollowerAttachResponse,
  FollowerBootstrapRequest,
  FollowerBootstrapResponse,
  FollowerJoinRequest,
  TrayBootstrapEvent,
  TrayBootstrapStatus,
  TrayIceCandidate,
  TrayLeaderSummary,
  TraySessionDescription,
  TurnIceServer,
} from '@slicc/shared-ts';
import { successorVersionFromLinkHeader } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';

const log = createLogger('tray-follower');

function appendJsonParam(url: string): string {
  const u = new URL(url);
  u.searchParams.set('json', 'true');
  return u.toString();
}

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
  /** Set when `code === 'TRAY_SUPERSEDED'` — the join URL to follow instead. */
  supersededByJoinUrl?: string;
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
  const fetchUrl = appendJsonParam(options.joinUrl);
  const response = await (options.fetchImpl ?? fetch)(fetchUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      controllerId: options.controllerId,
      runtime: options.runtime,
    }),
  });

  // #1957: a superseded tray states the replacement twice — in the body, and
  // as an RFC 5829 `successor-version` link. The header is the channel that
  // survives a body-shape change, so it wins when both are present and it
  // alone is enough to follow the hop.
  const successorFromLink = successorVersionFromLinkHeader(response.headers.get('Link'));

  let body: FollowerAttachResponse;
  try {
    body = await readFollowerAttachResponse(response);
  } catch (error) {
    if (!successorFromLink) throw error;
    // The body didn't validate but the hub told us where the tray went. That
    // is a redirect, not a dead end — dead-ending on an unrecognized body is
    // exactly how #1956 stranded the iOS follower.
    log.info('Follower tray attach: unreadable body with a successor-version link, following it');
    return {
      trayId: '',
      controllerId: options.controllerId ?? '',
      participantCount: 0,
      leader: null,
      action: 'fail',
      code: 'TRAY_SUPERSEDED',
      supersededByJoinUrl: successorFromLink,
    };
  }

  log.info('Follower tray attach response', {
    trayId: body.trayId,
    action: body.result.action,
    code: body.result.code,
    participantCount: body.participantCount,
    supersededByLink: Boolean(successorFromLink),
  });
  return normalizeFollowerAttachResponse(body, successorFromLink);
}

export function normalizeFollowerAttachResponse(
  response: FollowerAttachResponse,
  /** Replacement join URL read from the response's `successor-version` link. */
  successorFromLink?: string | null
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

  // A named replacement is normalized to the supersede plan whatever the body
  // called it: the link wins over the body's `joinUrl` (it is the channel that
  // survives a body-shape change, #1957) and rides on every action, so a hub
  // that stops saying `fail` / `TRAY_SUPERSEDED` still redirects every caller
  // that reads this plan.
  const supersededByJoinUrl =
    successorFromLink ??
    (response.result.action === 'fail' && response.result.code === 'TRAY_SUPERSEDED'
      ? response.result.joinUrl
      : undefined);
  if (supersededByJoinUrl) {
    return {
      ...base,
      action: 'fail',
      code: 'TRAY_SUPERSEDED',
      error: 'error' in response.result ? response.result.error : undefined,
      supersededByJoinUrl,
    };
  }

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
  body: FollowerBootstrapRequest
): Promise<FollowerBootstrapResponse> {
  const fetchUrl = appendJsonParam(options.joinUrl);
  const response = await (options.fetchImpl ?? fetch)(fetchUrl, {
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

/**
 * The wire shapes as they arrive: the fields these validators read, each still
 * unverified. Naming them keeps the guards honest about what they accept —
 * a typo in a key is a type error rather than a silently `undefined` bag slot.
 */
interface UnverifiedAttachResponse {
  trayId?: unknown;
  controllerId?: unknown;
  role?: unknown;
  participantCount?: unknown;
  result?: unknown;
}

interface UnverifiedAttachResult {
  action?: unknown;
  code?: unknown;
  retryAfterMs?: unknown;
  bootstrap?: unknown;
  error?: unknown;
  joinUrl?: unknown;
}

interface UnverifiedBootstrapResponse {
  trayId?: unknown;
  controllerId?: unknown;
  role?: unknown;
  participantCount?: unknown;
  bootstrap?: unknown;
  events?: unknown;
}

interface UnverifiedBootstrapStatus {
  controllerId?: unknown;
  bootstrapId?: unknown;
  attempt?: unknown;
  state?: unknown;
  expiresAt?: unknown;
  cursor?: unknown;
  maxRetries?: unknown;
  retriesRemaining?: unknown;
}

function isFollowerAttachResponse(value: unknown): value is FollowerAttachResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const response = value as UnverifiedAttachResponse;
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

  const attachResult = result as UnverifiedAttachResult;
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
    if (attachResult['code'] === 'TRAY_SUPERSEDED') {
      return (
        typeof attachResult['error'] === 'string' && typeof attachResult['joinUrl'] === 'string'
      );
    }
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

  const response = value as UnverifiedBootstrapResponse;
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

  const status = value as UnverifiedBootstrapStatus;
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
