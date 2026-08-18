import type { ConeConfigIndex, ConeEntry } from '@slicc/cloud-core';

interface CloudErrorDetails {
  retryAfterSec?: number;
  running?: number;
  paused?: number;
  cap?: number | { running: number; paused: number };
  sandboxId?: string;
}

interface DefaultSuccessPayload {
  ok: true;
}

interface StartSuccessPayload {
  sandboxId: string;
  name?: string;
  joinUrl: string;
}

interface ResumeSuccessPayload {
  sandboxId: string;
  joinUrl: string;
  trayRebuilt: boolean;
}

interface ListSuccessPayload {
  cones: ConeEntry[];
}

interface ConeConfigSuccessPayload {
  coneConfigIndex: ConeConfigIndex | null;
}

interface AdminStatsSuccessPayload {
  note: string;
}

type CloudSuccessPayload =
  | DefaultSuccessPayload
  | StartSuccessPayload
  | ResumeSuccessPayload
  | ListSuccessPayload
  | ConeConfigSuccessPayload
  | AdminStatsSuccessPayload;

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: CloudErrorDetails
): Response {
  return Response.json({ error: code, message, ...(details ? { details } : {}) }, { status });
}

export function okResponse(payload: CloudSuccessPayload = { ok: true }): Response {
  return Response.json(payload, { status: 200 });
}
