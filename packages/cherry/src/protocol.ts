/**
 * Cherry host protocol — standalone SDK mirror.
 *
 * This is a structural copy of the postMessage envelope contract between the
 * embedded SLICC follower (iframe) and the @ai-ecoverse/cherry host SDK. The SDK must
 * NOT import from @slicc/webapp (it ships independently to third-party origins),
 * so the shapes are duplicated here.
 *
 * CROSS-CHECK: keep this structurally identical to the canonical definition in
 * `packages/webapp/src/cdp/cherry-host-protocol.ts` — same envelope union,
 * `CHERRY_PROTOCOL_VERSION`, `isCherryEnvelope`, `AcceptContext`, and the
 * three-factor `acceptEnvelope` gate. The ONLY intended difference is the
 * package location (no webapp import).
 *
 * Security: every inbound message is validated by acceptEnvelope() against three
 * independent factors — origin allowlist, MessageEvent.source identity, and a
 * per-mount channelId nonce — before any synthetic CDP is acted on.
 */

export const CHERRY_PROTOCOL_VERSION = 1;

export interface CherryHandshakeHello {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'handshake.hello';
  capabilities: { navigate: boolean; screenshot: boolean; openUrl: boolean };
}

export interface CherryHandshakeWelcome {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'handshake.welcome';
  /** Tray join URL the host supplied; the follower embeds against it. */
  joinUrl?: string;
  /** UI feature toggles. All features default to true. */
  features?: {
    terminal: boolean;
    files: boolean;
    memory: boolean;
    browser: boolean;
    modelSelector: boolean;
    thinkingMode: boolean;
    history: boolean;
    nav: boolean;
    newSprinkle: boolean;
    monitor: boolean;
  };
}

export interface CherryCdpRequest {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.request';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CherryCdpResponse {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.response';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface CherryCdpEvent {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.event';
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CherryPermissionRequest {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'permission.request';
  id: number;
  domain: string;
}

export interface CherryPermissionResponse {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'permission.response';
  id: number;
  granted: boolean;
}

export interface CherryHostEvent {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'host.event';
  name: string;
  detail?: unknown;
}

export interface CherrySliccEvent {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'slicc.event';
  name: string;
  detail?: unknown;
}

export type CherryEnvelope =
  | CherryHandshakeHello
  | CherryHandshakeWelcome
  | CherryCdpRequest
  | CherryCdpResponse
  | CherryCdpEvent
  | CherryPermissionRequest
  | CherryPermissionResponse
  | CherryHostEvent
  | CherrySliccEvent;

const KINDS = new Set<CherryEnvelope['kind']>([
  'handshake.hello',
  'handshake.welcome',
  'cdp.request',
  'cdp.response',
  'cdp.event',
  'permission.request',
  'permission.response',
  'host.event',
  'slicc.event',
]);

export function isCherryEnvelope(value: unknown): value is CherryEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.cherry === CHERRY_PROTOCOL_VERSION &&
    typeof v.channelId === 'string' &&
    typeof v.kind === 'string' &&
    KINDS.has(v.kind as CherryEnvelope['kind'])
  );
}

export interface AcceptContext {
  /** Allowlisted origins of the counterpart frame. */
  allowOrigins: string[];
  /**
   * The MessageEventSource we expect (iframe.contentWindow or window.parent).
   * `null` means "accept any source" — callers MUST pass the real expectedSource
   * once known; `null` is only for an initial pre-handshake window where the
   * source isn't yet pinned (mirrors how `channelId: null` disables the nonce factor).
   */
  expectedSource: MessageEventSource | null;
  /** Pinned channel nonce. null only during pre-handshake (accept any). */
  channelId: string | null;
}

/**
 * Three-factor gate. ALL must hold before a message is acted on:
 *  1. event.origin is in the allowlist
 *  2. event.source is identity-equal to the expected window
 *  3. envelope.channelId equals the pinned nonce (skipped only when null = pre-handshake)
 */
export function acceptEnvelope(event: MessageEvent, ctx: AcceptContext): boolean {
  if (!ctx.allowOrigins.includes(event.origin)) return false;
  if (ctx.expectedSource !== null && event.source !== ctx.expectedSource) return false;
  if (!isCherryEnvelope(event.data)) return false;
  if (ctx.channelId !== null && event.data.channelId !== ctx.channelId) return false;
  return true;
}
