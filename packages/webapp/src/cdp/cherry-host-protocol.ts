/**
 * Cherry host protocol: the postMessage envelope contract between the embedded
 * SLICC follower (iframe) and the @ai-ecoverse/cherry host SDK.
 *
 * Security: every inbound message is validated by acceptEnvelope() against three
 * independent factors — origin allowlist, MessageEvent.source identity, and a
 * per-mount channelId nonce — before any synthetic CDP is acted on.
 */

export const CHERRY_PROTOCOL_VERSION = 2;

/**
 * Every wire version this build can negotiate, newest first (the first entry
 * MUST be CHERRY_PROTOCOL_VERSION). The follower iframe posts one
 * `handshake.hello` per entry (same channelId) and pins the negotiated version
 * from whichever `handshake.welcome` the host answers with; the host SDK keeps
 * accepting only its own CHERRY_PROTOCOL_VERSION. Embedders VENDOR the host
 * SDK, so a protocol bump must keep the previous version listed here until no
 * known embedder still ships it — dropping an entry hard-breaks those hosts
 * with an opaque handshake timeout (the 2026-07-27 labs incident).
 */
export const SUPPORTED_CHERRY_PROTOCOL_VERSIONS: readonly number[] = [2, 1];

export interface CherryHandshakeHello {
  /** Wire version stamp. Runtime-validated against an accepted-versions set. */
  cherry: number;
  channelId: string;
  kind: 'handshake.hello';
  capabilities: { navigate: boolean; screenshot: boolean; openUrl: boolean };
}

export interface CherryHandshakeWelcome {
  cherry: number;
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
    modelPicker: boolean;
    history: boolean;
    nav: boolean;
    monitor: boolean;
    showTimestamps: boolean;
  };
  /** JSON-serialized SliccTheme the follower should apply. */
  theme?: string;
  /**
   * JSON-serialized `DockTreeSpec` (see `@slicc/webcomponents`' `slicc-dock-tree.ts`)
   * the follower should load in place of its own persisted/default layout.
   * Applied once, at boot — static, like `theme`; there is no runtime
   * re-layout. Typically carries `locked: true` (tree-wide or per-leaf) so the
   * follower's own UI can't drag/resize/close what the host pushed.
   */
  layout?: string;
  /** Locked effort level. When set, the thinking-level picker is hidden. */
  effortLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * JSON-serialized feature-flag overrides (e.g. `{"panel-layouts":"on"}`) the
   * host wants applied for this embed. Applied once, at boot, session-only —
   * never written to localStorage. Only takes effect for flags that are
   * `userToggleable` and allowed for the `cherry` float (the same gate a local
   * user override must pass); an embedder is not a trusted operator of this
   * deployment, so it cannot flip a flag nobody marked safe for outside control.
   */
  flags?: string;
}

/**
 * Host → iframe: reply to a `handshake.hello` whose protocol version this host
 * cannot speak. Lets a version-skewed follower fail its connect() fast with an
 * actionable error instead of eating the full handshake timeout. Stamped with
 * the HOST's version (the follower diagnoses the skew from it); `channelId`
 * echoes the rejected hello's so the follower's three-factor gate attributes
 * the reply to its own handshake attempt.
 */
export interface CherryHandshakeVersionMismatch {
  cherry: number;
  channelId: string;
  kind: 'handshake.version-mismatch';
  /** The rejected hello's version, echoed for diagnostics. */
  peerVersion: number;
}

/**
 * Per-method CDP params/result bag. Shape is known only to the caller that
 * issued the method; the wire carries an opaque object.
 */
// biome-ignore lint/plugin: CDP params/result are per-method and open-ended; the follower relays them without inspecting fields, so there is no narrower shape to name here.
export type CherryCdpPayload = Record<string, unknown>;

export interface CherryCdpRequest {
  cherry: number;
  channelId: string;
  kind: 'cdp.request';
  id: number;
  method: string;
  /** Per-method CDP params; shape depends on the request method. */
  params?: CherryCdpPayload;
  sessionId?: string;
}

export interface CherryCdpResponse {
  cherry: number;
  channelId: string;
  kind: 'cdp.response';
  id: number;
  /** Per-method CDP result; shape depends on the request method. */
  result?: CherryCdpPayload;
  error?: { code: number; message: string };
}

export interface CherryCdpEvent {
  cherry: number;
  channelId: string;
  kind: 'cdp.event';
  method: string;
  /** Per-method CDP event params; shape depends on `method`. */
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

// ---------------------------------------------------------------------------
// Session export envelopes (host → iframe and iframe → host) — v2+ only.
// ---------------------------------------------------------------------------

/** Host → iframe: initiate a transcript export for the given session. */
export interface CherrySessionExportRequest {
  cherry: number;
  channelId: string;
  kind: 'session.export.request';
  requestId: string;
  /** `'active'` (default) or a frozen session ID. */
  sessionId?: 'active' | string;
}

/** Host → iframe: cancel an in-flight export (AbortSignal fired). */
export interface CherrySessionExportCancel {
  cherry: number;
  channelId: string;
  kind: 'session.export.cancel';
  requestId: string;
}

/**
 * Iframe → host: incremental progress update.
 * All fields are JSON-cloneable; no Blob or binary here.
 */
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

/**
 * Iframe → host: the verified application/zip Blob.
 * Blob is the only non-JSON-cloneable field; all other envelopes are
 * JSON-cloneable and may be structured-cloned through any postMessage bridge.
 */
export interface CherrySessionExportResponse {
  cherry: number;
  channelId: string;
  kind: 'session.export.response';
  requestId: string;
  /** Verified application/zip. Reject if blob.type !== 'application/zip'. */
  blob: Blob;
}

/** Iframe → host: the export failed with a terminal error code. */
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

/**
 * Fields the structural validators read off an inbound postMessage before
 * narrowing to a typed envelope. Extra keys may be present; only these are
 * inspected.
 */
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

/**
 * Structural envelope validator. `versions` is the set of wire versions the
 * caller currently accepts — strict own-version by default; the follower
 * passes SUPPORTED_CHERRY_PROTOCOL_VERSIONS while negotiating and narrows to
 * the single negotiated version once connected.
 */
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
  // Export envelopes require a non-empty requestId and kind-specific fields.
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
  /**
   * Wire versions to accept. Defaults to strict [CHERRY_PROTOCOL_VERSION];
   * see isCherryEnvelope.
   */
  versions?: readonly number[];
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
  if (!isCherryEnvelope(event.data, ctx.versions)) return false;
  if (ctx.channelId !== null && event.data.channelId !== ctx.channelId) return false;
  return true;
}

/** Envelope-shaped message with a non-accepted `cherry` version (version skew). */
export interface CherryVersionSkew {
  cherry: number;
  channelId: string;
  kind: string;
}

/**
 * True when a message is shaped like a cherry envelope but carries a protocol
 * version outside the caller's accepted set — i.e. the peer is a version-skewed
 * build, not postMessage noise. `isCherryEnvelope` (and therefore
 * `acceptEnvelope`) rejects these, so without this check a skewed peer is
 * indistinguishable from the generic handshake timeout. Callers log it
 * distinctly ("update the older side").
 */
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
