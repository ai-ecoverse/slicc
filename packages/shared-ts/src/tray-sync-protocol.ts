/**
 * Typed sync protocol for tray WebRTC data channels — canonical wire format.
 *
 * Leader → Follower: chat snapshots (single + chunked), streamed agent events,
 *   user-message echoes, scoop list, sprinkle list / content / updates,
 *   federated CDP (request + response + event), federated tab.open and its
 *   reply pair, federated FS (request + response), liveness (ping/pong/status/error).
 *
 * Follower → Leader: user input, abort, snapshot/scoop selection requests,
 *   sprinkle refresh + content fetch + lick, target advertisement, federated
 *   CDP (request + response + event), federated tab.open and its reply pair,
 *   federated FS (request + response), ping/pong.
 *
 * The iOS follower (`packages/ios-app/SliccFollower/Models/SyncProtocol.swift`)
 * mirrors a **subset** of this file: federated `fs.*` in both directions is
 * TS-only; iOS responds to leader-initiated `cdp.request` / `tab.open` (and
 * sends back `cdp.response` / `cdp.event` / `tab.opened`) but does NOT
 * originate either, so the follower-initiated CDP/tab.open paths are also
 * TS-only. The per-variant iOS decision is MECHANICALLY enforced by the
 * golden-fixture corpus
 * (`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts` →
 * `packages/ios-app/.../Fixtures/tray-sync-corpus.json`, decoded by both the
 * vitest and XCTest suites) — adding a variant here fails typecheck there
 * until it gets a fixture + explicit iOS expectation. See
 * `packages/ios-app/CLAUDE.md` "Protocol Mirror Invariant".
 *
 * This module holds the message unions and their payload-adjacent types
 * (types + pure guards only — platform-agnostic by construction). The
 * `TraySyncChannel` wrapper, chunking helpers, and typed factories live in
 * `@slicc/webapp` `scoops/tray-sync-protocol.ts` (they depend on
 * `TrayDataChannelLike` and the webapp logger), which re-exports everything
 * here for webapp-internal importers.
 */

import type { AgentEvent, ChatMessage, LickEvent, MessageAttachment } from './agent-wire-types.js';

/**
 * Runtime tag a cherry follower connects with (`StartPageFollowerTrayOptions.runtime`).
 * It is the advertisement-independent signal the leader uses to keep a cooperative
 * cherry host page out of flows it cannot satisfy (teleport selection) — see
 * `tray-leader-sync.ts:getBestFollowerForTeleport`. Kept here, next to the wire
 * format, because both the follower boot (`ui/`) and the leader (`scoops/`) must
 * agree on the exact string without one layer importing the other.
 */
export const CHERRY_RUNTIME_TAG = 'slicc-cherry';

/**
 * Tray sync protocol version, exchanged via the additive `hello` message both
 * sides send on channel open. A peer that never sends `hello` is a legacy
 * build (pre-versioning); a peer with a HIGHER version than ours means this
 * build is outdated — both cases log loudly instead of surfacing as silently
 * missing features. Bump when the wire format changes incompatibly.
 */
export const TRAY_SYNC_PROTOCOL_VERSION = 1;

/**
 * Additive version handshake, sent by BOTH sides as their first message on
 * channel open. Legacy peers drop it harmlessly (TS: unknown-message warn;
 * iOS: `.unknown`), so it is backward and forward compatible.
 */
export interface TraySyncHelloMessage {
  type: 'hello';
  protocolVersion: number;
  /** Optional runtime tag of the sender (e.g. 'slicc-standalone'). */
  runtime?: string;
}

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

export type LeaderToFollowerMessage =
  | { type: 'snapshot'; messages: ChatMessage[]; scoopJid: string }
  | {
      type: 'snapshot_chunk';
      chunkData: string;
      chunkIndex: number;
      totalChunks: number;
      scoopJid: string;
    }
  | { type: 'agent_event'; event: AgentEvent; scoopJid: string }
  | {
      type: 'user_message_echo';
      text: string;
      messageId: string;
      scoopJid: string;
      attachments?: MessageAttachment[];
    }
  | { type: 'status'; scoopStatus: string }
  | { type: 'error'; error: string }
  | { type: 'scoops.list'; scoops: ScoopSummary[]; activeScoopJid: string }
  | { type: 'sprinkles.list'; sprinkles: SprinkleSummary[] }
  | {
      type: 'sprinkle.content';
      requestId: string;
      sprinkleName: string;
      content: string;
      chunkIndex?: number;
      totalChunks?: number;
      error?: string;
    }
  | { type: 'sprinkle.update'; sprinkleName: string; data: unknown }
  | { type: 'sprinkle.reloaded'; sprinkleName: string }
  | { type: 'targets.registry'; targets: TrayTargetEntry[] }
  | {
      type: 'cdp.request';
      requestId: string;
      localTargetId: string;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    }
  | {
      type: 'cdp.response';
      requestId: string;
      result?: Record<string, unknown>;
      error?: string;
      chunkData?: string;
      chunkIndex?: number;
      totalChunks?: number;
    }
  | { type: 'cdp.event'; method: string; params: Record<string, unknown>; sessionId?: string }
  | { type: 'tab.open'; requestId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  | { type: 'preview.open'; requestId: string; url: string }
  | { type: 'fs.request'; requestId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | CherrySliccEventMessage
  | { type: 'theme.apply'; themeJson: string | null }
  | TraySyncHelloMessage
  | { type: 'ping' }
  | { type: 'pong' };

export type FollowerToLeaderMessage =
  | { type: 'user_message'; text: string; messageId: string; attachments?: MessageAttachment[] }
  | { type: 'abort' }
  | { type: 'new_session'; action: 'save' | 'skip' | 'erase' }
  | { type: 'request_snapshot'; scoopJid?: string }
  | { type: 'scoops.select'; scoopJid: string }
  | { type: 'sprinkles.refresh' }
  | { type: 'sprinkle.fetch'; requestId: string; sprinkleName: string }
  | {
      type: 'sprinkle.lick';
      sprinkleName: string;
      body: unknown;
      targetScoop?: string;
    }
  | { type: 'lick'; event: Omit<LickEvent, 'originFollowerId' | 'originLabel'> }
  | { type: 'targets.advertise'; targets: RemoteTargetInfo[]; runtimeId: string }
  | {
      type: 'cdp.request';
      requestId: string;
      targetRuntimeId: string;
      localTargetId: string;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    }
  | {
      type: 'cdp.response';
      requestId: string;
      result?: Record<string, unknown>;
      error?: string;
      chunkData?: string;
      chunkIndex?: number;
      totalChunks?: number;
    }
  | { type: 'cdp.event'; method: string; params: Record<string, unknown>; sessionId?: string }
  | { type: 'tab.open'; requestId: string; targetRuntimeId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  | { type: 'fs.request'; requestId: string; targetRuntimeId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | CherryHostEventMessage
  | TraySyncHelloMessage
  | { type: 'ping' }
  | { type: 'pong' };

// ---------------------------------------------------------------------------
// Target advertisement types
// ---------------------------------------------------------------------------

export interface RemoteTargetInfo {
  targetId: string;
  title: string;
  url: string;
  /** Distinguishes a real browser page from a cooperative cherry host page. */
  kind?: 'browser' | 'cherry' | 'preview';
  /**
   * Only present for kind === 'cherry'. What the host page lends to the leader,
   * expressed in the vocabulary this tray/teleport layer cares about: `network`
   * gates whether the target may serve `Network.*` CDP for teleport-pool
   * selection. NOTE: intentionally a DIFFERENT shape from the SDK handshake
   * `CherryHandshakeHello.capabilities` (`{ navigate; screenshot; openUrl }` in
   * cdp/cherry-host-protocol.ts) — `openUrl` is a sandbox-escape concern at the
   * host SDK boundary, whereas `network` is a teleport-routing concern here.
   * They are mapped, not equal.
   */
  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}

// ---------------------------------------------------------------------------
// Cherry event-passing messages
// ---------------------------------------------------------------------------

/** Host page → cone: a named event emitted by the cherry host page. */
export interface CherryHostEventMessage {
  type: 'cherry.host_event';
  targetId: string;
  name: string;
  detail?: unknown;
}

/** Cone → host page: a named event sent to the cherry host page. */
export interface CherrySliccEventMessage {
  type: 'cherry.slicc_event';
  targetId: string;
  name: string;
  detail?: unknown;
}

export function isCherryHostEventMessage(m: unknown): m is CherryHostEventMessage {
  return (
    typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cherry.host_event'
  );
}

export function isCherrySliccEventMessage(m: unknown): m is CherrySliccEventMessage {
  return (
    typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cherry.slicc_event'
  );
}

// ---------------------------------------------------------------------------
// Scoop / sprinkle summary types (for follower views)
// ---------------------------------------------------------------------------

/** Lightweight scoop description sent to followers for their scoop picker / swipe view. */
export interface ScoopSummary {
  jid: string;
  name: string;
  folder: string;
  isCone: boolean;
  assistantLabel: string;
  trigger?: string;
}

/** Lightweight sprinkle description sent to followers for the sprinkle sidebar. */
export interface SprinkleSummary {
  /** Sprinkle name (basename without .shtml). */
  name: string;
  /** Display title. */
  title: string;
  /** VFS path (used for chunked content fetch). */
  path: string;
  /** Whether this sprinkle is currently open in the leader's UI. */
  open: boolean;
  /** Whether this sprinkle should auto-open. */
  autoOpen: boolean;
  /**
   * Raw icon spec from the leader's `.shtml` (`<link rel="icon">` or
   * `data-sprinkle-icon`). Forwarded so the follower's rail can render the
   * same per-sprinkle glyph as the leader instead of the default sparkle.
   * Format matches `Sprinkle.icon` in `sprinkle-discovery.ts` — a Lucide
   * name, VFS path, inline `<svg>`, or `data:` URL. In the follower rail only
   * a Lucide kebab-name renders as the glyph (`isLucideIconSpec` in
   * `wc-sprinkles.ts`); every other form — a VFS path (not addressable from
   * the follower), inline `<svg>`, or `data:` URL — falls back to the default
   * sparkles glyph.
   */
  icon?: string;
}

export interface TrayTargetEntry {
  targetId: string; // Unique within the tray: "{runtimeId}:{localTargetId}"
  localTargetId: string; // The original targetId on the owning runtime
  runtimeId: string; // Which runtime owns this target
  title: string;
  url: string;
  isLocal: boolean; // True if owned by the receiving runtime (set by consumer, not registry)
  /** Distinguishes a real browser page from a cooperative cherry host page. */
  kind?: 'browser' | 'cherry' | 'preview';
  /**
   * Only present for kind === 'cherry'. What the host page lends to the leader,
   * expressed in the vocabulary this tray/teleport layer cares about: `network`
   * gates whether the target may serve `Network.*` CDP for teleport-pool
   * selection. NOTE: intentionally a DIFFERENT shape from the SDK handshake
   * `CherryHandshakeHello.capabilities` (`{ navigate; screenshot; openUrl }` in
   * cdp/cherry-host-protocol.ts) — `openUrl` is a sandbox-escape concern at the
   * host SDK boundary, whereas `network` is a teleport-routing concern here.
   * They are mapped, not equal.
   */
  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}

// ---------------------------------------------------------------------------
// Cookie teleport types
// ---------------------------------------------------------------------------

/** Chrome CDP Network.Cookie shape used for teleporting cookies between runtimes. */
export interface CookieTeleportCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  priority?: 'Low' | 'Medium' | 'High';
  sameParty?: boolean;
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
  sourcePort?: number;
  partitionKey?: string;
}

// ---------------------------------------------------------------------------
// VFS sync protocol types
// ---------------------------------------------------------------------------

/** A single FS operation request sent over the data channel. */
export type TrayFsRequest =
  | { op: 'readFile'; path: string; encoding?: 'utf-8' | 'binary' }
  | { op: 'writeFile'; path: string; content: string; encoding: 'utf-8' | 'base64' }
  | { op: 'stat'; path: string }
  | { op: 'readDir'; path: string }
  | { op: 'mkdir'; path: string; recursive?: boolean }
  | { op: 'rm'; path: string; recursive?: boolean }
  | { op: 'exists'; path: string }
  | { op: 'walk'; path: string };

/** A single FS operation response. Chunked responses use chunkIndex/totalChunks for large file content. */
export type TrayFsResponse =
  | { ok: true; data: TrayFsResponseData; chunkIndex?: number; totalChunks?: number }
  | { ok: false; error: string; code?: string };

/** Possible data payloads for successful FS responses. */
export type TrayFsResponseData =
  | { type: 'file'; content: string; encoding: 'utf-8' | 'base64' }
  | {
      type: 'stat';
      stat: {
        type: 'file' | 'directory' | 'symlink';
        size: number;
        mtime: number;
        ctime: number;
      };
    }
  | {
      type: 'dirEntries';
      entries: Array<{ name: string; type: 'file' | 'directory' | 'symlink' }>;
    }
  | { type: 'exists'; exists: boolean }
  | { type: 'paths'; paths: string[] }
  | { type: 'void' };

export type TraySyncMessage = LeaderToFollowerMessage | FollowerToLeaderMessage;

/**
 * Compile-time exhaustiveness guard for protocol dispatchers.
 *
 * Call this from the `default:` branch of a `switch (message.type)` over a
 * protocol union. Because the parameter is `never`, adding a new message
 * variant to the union fails compile in every dispatcher until that
 * dispatcher makes an explicit decision — a documented no-op `case` is
 * allowed, silence is not.
 *
 * Unlike a classic `assertNever` this must NOT throw: at runtime a
 * version-skewed peer (shipped iOS binary, older hosted UI, cherry embed)
 * can legitimately deliver a message type this build doesn't know. It
 * returns the loosely-typed message so the caller can log it loudly.
 */
export function unhandledProtocolMessage(message: never): { type?: string } {
  return message as { type?: string };
}
