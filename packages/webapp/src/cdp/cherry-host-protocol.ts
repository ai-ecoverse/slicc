export const CHERRY_PROTOCOL_VERSION = 2;

export const SUPPORTED_CHERRY_PROTOCOL_VERSIONS: readonly number[] = [2, 1];

export interface CherryHandshakeHello {
  cherry: number;
  channelId: string;
  kind: 'handshake.hello';
  capabilities: { navigate: boolean; screenshot: boolean; openUrl: boolean };
}

export interface CherryHandshakeWelcome {
  cherry: number;
  channelId: string;
  kind: 'handshake.welcome';

  joinUrl?: string;

  features?: {
    terminal: boolean;
    files: boolean;
    memory: boolean;
    browser: boolean;
    modelPicker: boolean;
    history: boolean;
    nav: boolean;
    monitor: boolean;
    showTimestamps: boolean;
  };

  theme?: string;

  layout?: string;

  effortLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

  flags?: string;
}

export interface CherryHandshakeVersionMismatch {
  cherry: number;
  channelId: string;
  kind: 'handshake.version-mismatch';

  peerVersion: number;
}

// biome-ignore lint/plugin: CDP params/result are per-method and open-ended; the follower relays them without inspecting fields, so there is no narrower shape to name here.
export type CherryCdpPayload = Record<string, unknown>;

export interface CherryCdpRequest {
  cherry: number;
  channelId: string;
  kind: 'cdp.request';
  id: number;
  method: string;

  params?: CherryCdpPayload;
  sessionId?: string;
}

export interface CherryCdpResponse {
  cherry: number;
  channelId: string;
  kind: 'cdp.response';
  id: number;

  result?: CherryCdpPayload;
  error?: { code: number; message: string };
}

export interface CherryCdpEvent {
  cherry: number;
  channelId: string;
  kind: 'cdp.event';
  method: string;

  params?: CherryCdpPayload;
  sessionId?: string;
}

export interface CherryPermissionRequest {
  cherry: number;
  channelId: string;
  kind: 'permission.request';
  id: number;
  domain: string;
}

export interface CherryPermissionResponse {
  cherry: number;
  channelId: string;
  kind: 'permission.response';
  id: number;
  granted: boolean;
}

export interface CherryHostEvent {
  cherry: number;
  channelId: string;
  kind: 'host.event';
  name: string;
  detail?: unknown;
}

export interface CherrySliccEvent {
  cherry: number;
  channelId: string;
  kind: 'slicc.event';
  name: string;
  detail?: unknown;
}

export interface CherrySessionExportRequest {
  cherry: number;
  channelId: string;
  kind: 'session.export.request';
  requestId: string;

  sessionId?: 'active' | string;
}

export interface CherrySessionExportCancel {
  cherry: number;
  channelId: string;
  kind: 'session.export.cancel';
  requestId: string;
}

export interface CherrySessionExportProgress {
  cherry: number;
  channelId: string;
  kind: 'session.export.progress';
  requestId: string;
  phase:
    | 'waiting-for-conversations'
    | 'collecting'
    | 'redacting'
    | 'packaging'
    | 'transferring'
    | 'complete';
  processedBytes?: number;
  estimatedBytes?: number;
}

export interface CherrySessionExportResponse {
  cherry: number;
  channelId: string;
  kind: 'session.export.response';
  requestId: string;

  blob: Blob;
}

export interface CherrySessionExportError {
  cherry: number;
  channelId: string;
  kind: 'session.export.error';
  requestId: string;
  code: string;
}

export type CherryEnvelope =
  | CherryHandshakeHello
  | CherryHandshakeWelcome
  | CherryHandshakeVersionMismatch
  | CherryCdpRequest
  | CherryCdpResponse
  | CherryCdpEvent
  | CherryPermissionRequest
  | CherryPermissionResponse
  | CherryHostEvent
  | CherrySliccEvent
  | CherrySessionExportRequest
  | CherrySessionExportCancel
  | CherrySessionExportProgress
  | CherrySessionExportResponse
  | CherrySessionExportError;

const KINDS = new Set<CherryEnvelope['kind']>([
  'handshake.hello',
  'handshake.welcome',
  'handshake.version-mismatch',
  'cdp.request',
  'cdp.response',
  'cdp.event',
  'permission.request',
  'permission.response',
  'host.event',
  'slicc.event',
  'session.export.request',
  'session.export.cancel',
  'session.export.progress',
  'session.export.response',
  'session.export.error',
]);

interface CherryWireProbe {
  cherry?: unknown;
  channelId?: unknown;
  kind?: unknown;
  peerVersion?: unknown;
  requestId?: unknown;
  phase?: unknown;
  blob?: unknown;
  code?: unknown;
}

export function isCherryEnvelope(
  value: unknown,
  versions: readonly number[] = [CHERRY_PROTOCOL_VERSION]
): value is CherryEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as CherryWireProbe;
  if (
    typeof v.cherry !== 'number' ||
    !versions.includes(v.cherry) ||
    typeof v.channelId !== 'string' ||
    typeof v.kind !== 'string' ||
    !KINDS.has(v.kind as CherryEnvelope['kind'])
  )
    return false;
  const k = v.kind as CherryEnvelope['kind'];
  if (k === 'handshake.version-mismatch' && typeof v.peerVersion !== 'number') return false;

  if (
    k === 'session.export.request' ||
    k === 'session.export.cancel' ||
    k === 'session.export.progress' ||
    k === 'session.export.response' ||
    k === 'session.export.error'
  ) {
    if (typeof v.requestId !== 'string' || v.requestId === '') return false;
    if (k === 'session.export.progress' && typeof v.phase !== 'string') return false;
    if (k === 'session.export.response' && !(v.blob instanceof Blob)) return false;
    if (k === 'session.export.error' && typeof v.code !== 'string') return false;
  }
  return true;
}

export interface AcceptContext {
  allowOrigins: string[];

  expectedSource: MessageEventSource | null;

  channelId: string | null;

  versions?: readonly number[];
}

export function acceptEnvelope(event: MessageEvent, ctx: AcceptContext): boolean {
  if (!ctx.allowOrigins.includes(event.origin)) return false;
  if (ctx.expectedSource !== null && event.source !== ctx.expectedSource) return false;
  if (!isCherryEnvelope(event.data, ctx.versions)) return false;
  if (ctx.channelId !== null && event.data.channelId !== ctx.channelId) return false;
  return true;
}

export interface CherryVersionSkew {
  cherry: number;
  channelId: string;
  kind: string;
}

export function isCherryVersionMismatch(
  value: unknown,
  supported: readonly number[] = [CHERRY_PROTOCOL_VERSION]
): value is CherryVersionSkew {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as CherryWireProbe;
  return (
    typeof v.cherry === 'number' &&
    !supported.includes(v.cherry) &&
    typeof v.channelId === 'string' &&
    typeof v.kind === 'string'
  );
}
