/**
 * Typed sync protocol for tray WebRTC data channels — canonical wire format.
 *
 * Leader → Follower: chat snapshots (single + chunked), streamed agent events,
 *   user-message echoes, scoop list, model catalog + selection state,
 *   sprinkle list / content / updates,
 *   federated CDP (request + response + event), federated tab.open and its
 *   reply pair, federated FS (request + response), liveness (ping/pong/status/error).
 *
 * Follower → Leader: user input, abort, snapshot/scoop selection requests,
 *   model catalog requests + model/thinking selection, sprinkle refresh +
 *   content fetch + lick, target advertisement, federated
 *   CDP (request + response + event), federated tab.open and its reply pair,
 *   federated FS (request + response), ping/pong.
 *
 * The iOS follower (`packages/swift-trayfollower/Sources/SliccTrayFollower/Models/SyncProtocol.swift`)
 * mirrors a **subset** of this file: federated `fs.*` in both directions is
 * TS-only; iOS responds to leader-initiated `cdp.request` / `tab.open` (and
 * sends back `cdp.response` / `cdp.event` / `tab.opened`) but does NOT
 * originate `tab.open` against another runtime, so that path is TS-only. iOS
 * DOES originate `tab.teleport.request` (pull a tray tab here, with state).
 * The delegated-OAuth pair (`oauth.popup.*`) is TS-only: iOS has no popup
 * model and never advertises `capabilities.oauthPopup`. The per-variant iOS decision is MECHANICALLY enforced by the
 * golden-fixture corpus
 * (`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts` →
 * `packages/ios-app/.../Fixtures/tray-sync-corpus.json`, decoded by both the
 * vitest and XCTest suites) — adding a variant here fails typecheck there
 * until it gets a fixture + explicit iOS expectation. See
 * `packages/ios-app/CLAUDE.md` "Protocol Mirror Invariant".
 *
 * This module holds the message unions, their payload-adjacent types, and the
 * pure helpers that operate only over them (guards, CDP-response chunking) —
 * platform-agnostic by construction. The `TraySyncChannel` wrapper, the
 * snapshot chunking helpers, and the typed factories live in `@slicc/webapp`
 * `scoops/tray-sync-protocol.ts` (they depend on `TrayDataChannelLike` and the
 * webapp logger), which re-exports the types here for webapp-internal
 * importers.
 */

import type { AgentEvent, ChatMessage, LickEvent, MessageAttachment } from './agent-wire-types.js';
import type { TranscriptExportErrorCode } from './transcript-export.js';

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
export const TRAY_SYNC_PROTOCOL_VERSION = 6;

/**
 * An opaque Chrome DevTools Protocol payload — a `params` or `result` bag.
 *
 * This is the one shape in this file that genuinely has none: CDP defines a
 * different object per method across hundreds of methods, and the tray relays
 * them verbatim without ever inspecting a field. Naming it beats repeating the
 * open bag at seven call sites, and it marks the boundary where narrowing is
 * the consumer's job — the CDP client that issued the method knows the shape.
 */
// biome-ignore lint/plugin: CDP params/result are per-method and open-ended; the tray relays them without inspecting fields.
export type CDPPayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Transcript export selector
// ---------------------------------------------------------------------------

/**
 * Which transcript the follower is requesting.
 * - `active`: the leader's current in-session transcript.
 * - `frozen`: a specific archived session identified by `sessionId`.
 */
export type TranscriptExportSelector = { kind: 'active' } | { kind: 'frozen'; sessionId: string };

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
  /**
   * Optional capability advertisement (additive — legacy peers omit it). The
   * only capability today is `exec`: this peer accepts `exec.request`. Leaders
   * set it when their virtual shell is wired; the `slicc … follow` CLI sets it
   * when it has a real OS runner; iOS sets it for its restricted, non-shell
   * `open` verb. Browser followers advertise false or omit it. See the `exec.*`
   * messages below.
   */
  capabilities?: TraySyncCapabilities;
  /**
   * Optional one-line description of an exec-capable follower (additive). CLI
   * and iOS followers describe their supported surface, and the leader exposes
   * it to the agent through `ssh --list`. Legacy and browser peers omit it.
   */
  motd?: string;
}

/** Peer capability advertisement carried on `hello`. */
export interface TraySyncCapabilities {
  /**
   * This peer accepts `exec.request`. A receiver may run a shell or expose only
   * a restricted verb set; its MOTD documents the supported surface.
   */
  exec?: boolean;
  /**
   * This peer hosts CDP-driveable browser targets and accepts `tab.open`.
   * Leaders use it to keep exec-only followers (CLI) out of teleport
   * selection even before any `targets.advertise` arrives. Additive — legacy
   * peers omit it, and the leader then falls back to advertised-target
   * heuristics.
   */
  browser?: boolean;
  /**
   * This peer can host an interactive OAuth popup: it has a window, a
   * permissions surface, and a human. Leaders use it to pick a follower to
   * delegate `oauth.popup.request` to (issue #1915). Exec-only followers
   * (CLI) and iOS never set it.
   */
  oauthPopup?: boolean;
}

// ---------------------------------------------------------------------------
// Transport-level chunk framing
// ---------------------------------------------------------------------------

/**
 * Discriminant of the transport-level chunk frame.
 *
 * A chunk frame is deliberately NOT a member of `LeaderToFollowerMessage` or
 * `FollowerToLeaderMessage`: it belongs to the layer *below* the message union,
 * the same way TCP segments sit below an HTTP request. Senders split an
 * oversize serialized message into frames; receivers reassemble them and only
 * then decode the union. Consequences, all deliberate:
 *
 * - No golden-fixture corpus entry and no per-variant iOS decode expectation —
 *   the corpus enumerates the message unions, and this is not in them.
 * - Every message type is covered, including ones not written yet. The bug this
 *   closes (#1700) was a *class* of bug: any unbounded payload on any type.
 * - Handler switches never see it. All three runtimes intercept before decode:
 *   TS `TraySyncChannel`, Go `Conn.dispatch`, Swift `handleMessage`.
 *
 * The `__` prefix marks it as reserved transport vocabulary and guarantees it
 * can never collide with a semantic message type.
 */
export const TRAY_CHUNK_FRAME_TYPE = '__chunk';

/**
 * One frame of a chunked message. `chunkData` slices are concatenated in
 * `chunkIndex` order to recover the original serialized message.
 *
 * Field names mirror the pre-existing per-type chunkers (`snapshot_chunk`,
 * `cdp.response`, `sprinkle.content`, `fs.response`) so the wire vocabulary
 * stays uniform. Those four still chunk at their own thresholds; they now sit
 * safely *under* this transport limit rather than being the only things that
 * respected any limit at all.
 */
export interface TrayChunkFrame {
  type: typeof TRAY_CHUNK_FRAME_TYPE;
  /** Groups frames of one message. Unique per sender, per message. */
  chunkId: string;
  /** 0-based position of this frame. */
  chunkIndex: number;
  /** Total frame count for this message; identical on every frame. */
  totalChunks: number;
  /** A slice of the serialized message. */
  chunkData: string;
}

/**
 * Fallback max message size (bytes) when the SCTP transport hasn't reported
 * one. 65536 is the floor every SCTP implementation must accept (RFC 8831 §6.6
 * — a peer advertising less is non-conformant), so chunking to it is always
 * safe. Chrome 152 reports 262144; consulting the real value only buys larger
 * frames, never correctness.
 */
export const TRAY_DEFAULT_MAX_MESSAGE_BYTES = 65536;

/**
 * Hard ceiling (bytes) on a single serialized message, chunking included.
 * Beyond this the sender refuses loudly instead of flooding the SCTP buffer —
 * ~16 MB of queued data earns `OperationError: RTCDataChannel send queue is
 * full`, which drops the message anyway and can wedge the channel for
 * everything behind it, keepalive included.
 *
 * 8 MiB clears the payload this bound exists for by a wide margin: a 1536 px
 * `open --view --size high` screenshot is ~1-3 MB base64.
 */
export const TRAY_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * Refuse to start a chunked send while this many bytes (or more) are already
 * queued in the SCTP transport. Applies to chunked sends ONLY — small messages
 * still go out under congestion so keepalive ping/pong can't be starved by a
 * backed-up channel, which would make a merely congested peer look dead.
 */
export const TRAY_SEND_HIGH_WATER_BYTES = 8 * 1024 * 1024;

/**
 * Max frames one message may be split into.
 *
 * Bounds the allocation a receiver performs on the FIRST frame of a message:
 * `totalChunks` is peer-controlled, and allocating per-frame bookkeeping for a
 * claimed billion frames exhausts the receiver before any payload arrives.
 * 8192 is far above what any sender here produces — the 8 MiB cap over ~16 KiB
 * frames is ~512 — while keeping the eager allocation trivial.
 */
export const TRAY_MAX_CHUNK_COUNT = 8192;

/** Max messages being reassembled concurrently before the oldest is evicted. */
export const TRAY_MAX_PENDING_REASSEMBLIES = 8;

/** Max bytes held across all in-flight reassemblies before the oldest is evicted. */
export const TRAY_MAX_REASSEMBLY_BYTES = 32 * 1024 * 1024;

/** Narrowing guard for an inbound transport frame, ahead of union decode. */
export function isTrayChunkFrame(value: unknown): value is TrayChunkFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Partial<TrayChunkFrame>;
  return (
    frame.type === TRAY_CHUNK_FRAME_TYPE &&
    typeof frame.chunkId === 'string' &&
    typeof frame.chunkIndex === 'number' &&
    typeof frame.totalChunks === 'number' &&
    typeof frame.chunkData === 'string' &&
    Number.isInteger(frame.chunkIndex) &&
    Number.isInteger(frame.totalChunks) &&
    frame.totalChunks > 0 &&
    frame.totalChunks <= TRAY_MAX_CHUNK_COUNT &&
    frame.chunkIndex >= 0 &&
    frame.chunkIndex < frame.totalChunks
  );
}

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

export type LeaderToFollowerMessage =
  // Transcript export (leader → follower)
  | { type: 'transcript.export.pending'; requestId: string }
  | { type: 'transcript.export.denied'; requestId: string }
  /**
   * Delegated approval prompt (v4). Sent **only** when the leader has no
   * interactive human of its own — the hosted-leader (cloud) float, where the
   * leader tab is headless Chromium in an e2b sandbox. The requesting follower
   * renders the same approval dialog the leader would have shown and replies
   * with `transcript.export.approve.response`.
   *
   * Carries no transcript metadata beyond what the follower already supplied in
   * its own request (`selector`), plus an optional size estimate.
   */
  | {
      type: 'transcript.export.approve.request';
      requestId: string;
      selector: TranscriptExportSelector;
      estimatedBytes?: number;
    }
  | {
      type: 'transcript.export.start';
      requestId: string;
      filename: string;
      estimatedBytes?: number;
    }
  | { type: 'transcript.export.chunk'; requestId: string; index: number; data: string }
  | {
      type: 'transcript.export.complete';
      requestId: string;
      chunks: number;
      byteLength: number;
      sha256: string;
    }
  | { type: 'transcript.export.error'; requestId: string; code: TranscriptExportErrorCode }
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
  | { type: 'status'; scoopStatus: string; scoopJid: string }
  | { type: 'error'; error: string }
  | { type: 'scoops.list'; scoops: ScoopSummary[]; activeScoopJid: string }
  /**
   * Compact catalog rows normally remain below the 64 KiB CDP chunk threshold.
   * A bespoke semantic chunk variant is unnecessary: the generic
   * `TrayChunkFrame` layer frames and reassembles any oversize message.
   */
  | { type: 'models.list'; models: TrayModelCatalogEntry[] }
  | { type: 'model.state'; state: TrayModelSelectionState }
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
      params?: CDPPayload;
      sessionId?: string;
    }
  | {
      type: 'cdp.response';
      requestId: string;
      result?: CDPPayload;
      error?: string;
      chunkData?: string;
      chunkIndex?: number;
      totalChunks?: number;
    }
  | { type: 'cdp.event'; method: string; params: CDPPayload; sessionId?: string }
  | { type: 'tab.open'; requestId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  /**
   * Delegate an interactive OAuth hop to a follower whose human can actually
   * click it (issue #1915: `oauth-token` on a headless or unattended leader
   * used to prompt where nobody could answer). Only the provider's authorize
   * URL crosses the tray; the follower opens it, captures the terminal
   * callback URL, and replies with `oauth.popup.response`. Access and refresh
   * tokens NEVER cross the tray — the leader keeps nonce validation, the code
   * exchange, and account persistence.
   */
  | { type: 'oauth.popup.request'; requestId: string; url: string }
  | { type: 'preview.open'; requestId: string; url: string }
  | { type: 'fs.request'; requestId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | TrayExecRequestMessage
  | TrayExecChunkMessage
  | TrayExecResponseMessage
  | TrayExecSignalMessage
  | CherrySliccEventMessage
  | { type: 'theme.apply'; themeJson: string | null }
  | TraySyncHelloMessage
  | { type: 'ping' }
  | { type: 'pong' };

export type FollowerToLeaderMessage =
  // Transcript export (follower → leader)
  | { type: 'transcript.export.request'; requestId: string; selector: TranscriptExportSelector }
  | { type: 'transcript.export.cancel'; requestId: string }
  /**
   * Sent by the follower after a chunk has been durably appended to the spool.
   * The leader's bounded in-flight window (one chunk) waits for this before
   * sending the next chunk. Owner-scoped via requestId + follower identity.
   */
  | { type: 'transcript.export.ack'; requestId: string; index: number }
  /**
   * Reply to a delegated `transcript.export.approve.request` (v4). `approved`
   * is the human's verdict from the follower-rendered dialog. Any other
   * outcome (no handler, dialog error, timeout, disconnect) is resolved as a
   * denial by the leader — the gate is fail-closed.
   */
  | { type: 'transcript.export.approve.response'; requestId: string; approved: boolean }
  | {
      type: 'user_message';
      text: string;
      messageId: string;
      attachments?: MessageAttachment[];
      /** Steering send: interrupt the leader's running turn instead of queueing behind it. */
      steer?: boolean;
    }
  | { type: 'abort' }
  | { type: 'new_session'; action: 'save' | 'skip' | 'erase' }
  | { type: 'request_snapshot'; scoopJid?: string }
  | { type: 'scoops.select'; scoopJid: string }
  | { type: 'models.request' }
  | { type: 'model.select'; modelId: string }
  | {
      type: 'thinking.set';
      scoopJid: string;
      thinkingLevel: TrayThinkingLevel;
      effortOverride?: string;
    }
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
      params?: CDPPayload;
      sessionId?: string;
    }
  | {
      type: 'cdp.response';
      requestId: string;
      result?: CDPPayload;
      error?: string;
      chunkData?: string;
      chunkIndex?: number;
      totalChunks?: number;
    }
  | { type: 'cdp.event'; method: string; params: CDPPayload; sessionId?: string }
  | { type: 'tab.open'; requestId: string; targetRuntimeId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  /**
   * "Teleport that tab to me": the follower asks the leader to open a copy of
   * an existing tray target HERE, carrying its cookies + web storage. The
   * destination is always the requesting follower, derived from the channel
   * identity — never from the payload — so one follower cannot push tabs into
   * another. The leader replies on the existing `tab.opened` /
   * `tab.open.error` legs, keyed by `requestId`.
   */
  | { type: 'tab.teleport.request'; requestId: string; targetId: string }
  /**
   * Terminal result of a delegated OAuth popup. `redirectUrl` is the callback
   * URL the follower captured (carrying `?code=` + nonce) — never a token.
   * Absent `redirectUrl` with no `error` means the human cancelled.
   */
  | { type: 'oauth.popup.response'; requestId: string; redirectUrl?: string; error?: string }
  | { type: 'fs.request'; requestId: string; targetRuntimeId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | TrayExecRequestMessage
  | TrayExecChunkMessage
  | TrayExecResponseMessage
  | TrayExecSignalMessage
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
// Remote command execution (streaming, symmetric)
// ---------------------------------------------------------------------------

/** Maximum number of parameters forwarded from one approved x-callback result. */
export const TRAY_MAX_OPEN_CALLBACK_PARAM_COUNT = 16;

/**
 * Maximum serialized UTF-8 byte length of one approved x-callback JSON result,
 * not JavaScript string length. 16 KiB stays below
 * `TRAY_DEFAULT_MAX_MESSAGE_BYTES` (`65536` bytes), so the result always fits in
 * one unchunked tray message.
 */
export const TRAY_MAX_OPEN_CALLBACK_BYTES = 16 * 1024;

/**
 * Request command execution on the receiving peer. Symmetric like
 * `cdp.request`: present in BOTH direction unions. The LEADER sends it through
 * the `ssh` supplemental command to a capable follower. A `follow`-mode CLI
 * follower runs it through its configured OS runner; iOS accepts only its
 * restricted, non-shell verb set. A CLI follower sends it to the LEADER through
 * `slicc … exec`, where the in-browser virtual shell runs it. Only a peer that
 * advertised `hello.capabilities.exec` is a valid target; any other follower
 * replies with an error `exec.response` instead of running anything.
 */
export interface TrayExecRequestMessage {
  type: 'exec.request';
  requestId: string;
  /**
   * Command text. Shell-capable receivers interpret it as a command line;
   * restricted receivers accept only their documented verb grammar.
   */
  command: string;
  /** Optional working directory on the receiver. */
  cwd?: string;
  /** Optional environment variables merged over the receiver's own env. */
  env?: Record<string, string>;
}

/**
 * A streamed slice of a running command's output, emitted 0..n times between
 * an `exec.request` and its terminal `exec.response`. `data` is base64 so
 * arbitrary bytes (including binary output) survive the JSON/text data channel.
 * Chunk order within a stream is preserved by the reliable, ordered data
 * channel; stdout and stderr are independent streams and interleave only
 * approximately, exactly as a local shell does.
 */
export interface TrayExecChunkMessage {
  type: 'exec.chunk';
  requestId: string;
  stream: 'stdout' | 'stderr';
  /** base64-encoded output bytes. */
  data: string;
}

/**
 * Terminal reply for an `exec.request`. `exitCode` follows POSIX conventions
 * (128 + signal number when killed by a signal). `error` is set only when the
 * command could not be started or the receiver refuses to run it (e.g. a
 * follower that never advertised `exec` capability); `exitCode` is then a
 * non-zero sentinel.
 */
export interface TrayExecResponseMessage {
  type: 'exec.response';
  requestId: string;
  exitCode: number;
  /** Signal name when the process was terminated by a signal, else omitted. */
  signal?: string;
  /** Set when the command could not be run at all. */
  error?: string;
}

/**
 * Cancel a running `exec.request`. The requester sends it when its caller
 * aborts (the agent interrupts `ssh`, or the `exec` CLI receives SIGINT); the
 * receiver forwards the signal to the child process.
 */
export interface TrayExecSignalMessage {
  type: 'exec.signal';
  requestId: string;
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
}

// ---------------------------------------------------------------------------
// Model catalog / selection types
// ---------------------------------------------------------------------------

/** Thinking levels supported by the leader's per-scoop configuration. */
export type TrayThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * One model a follower may select, using the provider-qualified picker id.
 *
 * Credential-free by construction: the wire shape contains only display and
 * capability metadata — never an account id, user identity, avatar, key, or
 * token. `modelId` has the `providerId:modelId` form used by the leader picker.
 */
export interface TrayModelCatalogEntry {
  providerName: string;
  modelId: string;
  modelName: string;
  reasoning: boolean;
}

/** The leader's global model selection and one scoop's thinking configuration. */
export interface TrayModelSelectionState {
  activeModelId: string;
  scoopJid: string;
  thinkingLevel?: TrayThinkingLevel;
  effortOverride?: string;
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
  /**
   * Rendered lifecycle state for follower agent tabs. Absent from older
   * leaders.
   *
   * This union is CLOSED and stays closed. Every shipped follower switches on
   * these four values, and the ones already in the wild do not normalize what
   * they do not recognise — a fifth value would reach an old browser
   * follower's `data-state` unmatched and quietly cost a busy agent its
   * animation. Refinements go in {@link ScoopSummary.activity} instead, where
   * an old follower simply never looks.
   */
  state?: 'working' | 'broken' | 'initializing' | 'idle';
  /**
   * Optional REFINEMENT of `state`, carrying the agent avatar's expression
   * grammar. Absent from older leaders, ignored by older followers — which is
   * the whole point: adding detail here cannot change how any shipped build
   * renders `state`.
   *
   * - `thinking` — busy waiting on or streaming from the model.
   * - `tool` — busy running a tool call (the avatar squares up).
   * - `awaiting` — idle because the turn ended; the composer is the user's.
   *
   * Only meaningful alongside the `state` it refines (`thinking`/`tool` while
   * `working`, `awaiting` while `idle`). A consumer that does not recognise a
   * value MUST ignore it and fall back to `state` alone — the escape hatch
   * this field exists to provide, so the next refinement is free too.
   */
  activity?: 'thinking' | 'tool' | 'awaiting';
  /** Context-window fullness on the same 0-100 scale as the agent tabs. Absent from older leaders. */
  fill?: number;
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

// ---------------------------------------------------------------------------
// CDP response chunking helpers
// ---------------------------------------------------------------------------

/** Chunk size threshold in bytes — CDP responses larger than this are chunked. */
export const CDP_CHUNK_THRESHOLD = 64 * 1024; // 64 KB

/** Individual chunk size — smaller than threshold for safety margin. */
const CDP_CHUNK_SIZE = 32 * 1024; // 32 KB

/** Extract the CDP response message type from a union. */
type CDPResponseMessage = Extract<TraySyncMessage, { type: 'cdp.response' }>;

/**
 * Send a CDP response, automatically chunking if the serialized result exceeds CDP_CHUNK_THRESHOLD.
 * Returns true if all chunks were sent successfully, false if any send failed.
 */
export function sendCDPResponse(
  channel: { send(message: TraySyncMessage): boolean },
  requestId: string,
  result?: CDPPayload,
  error?: string
): boolean {
  // Error responses are always small — send directly
  if (error || !result) {
    return channel.send({ type: 'cdp.response', requestId, result, error } as CDPResponseMessage);
  }

  const serialized = JSON.stringify(result);
  if (serialized.length <= CDP_CHUNK_THRESHOLD) {
    // Small enough — send as a single message
    return channel.send({ type: 'cdp.response', requestId, result } as CDPResponseMessage);
  }

  // Split the serialized result into chunks
  const totalChunks = Math.ceil(serialized.length / CDP_CHUNK_SIZE);
  let allSent = true;
  for (let i = 0; i < totalChunks; i++) {
    const chunkData = serialized.slice(i * CDP_CHUNK_SIZE, (i + 1) * CDP_CHUNK_SIZE);
    const ok = channel.send({
      type: 'cdp.response',
      requestId,
      chunkData,
      chunkIndex: i,
      totalChunks,
    } as CDPResponseMessage);
    if (!ok) {
      allSent = false;
      // Send an error response to unblock the requester (error messages are small, will fit)
      channel.send({
        type: 'cdp.response',
        requestId,
        error: `Failed to send CDP response chunk ${i}/${totalChunks} (response was ${serialized.length} bytes)`,
      } as CDPResponseMessage);
      break;
    }
  }
  return allSent;
}

/**
 * Reassemble chunked CDP responses. Returns the parsed result when all chunks
 * have arrived, or null if still waiting for more chunks.
 *
 * @param buffers - shared buffer map, keyed by requestId
 * @param requestId - the request ID
 * @param message - the incoming cdp.response message
 * @returns { result, error } when complete, null when still accumulating
 */
export function reassembleCDPResponse(
  buffers: Map<string, { chunks: string[]; received: number; totalChunks: number }>,
  message: CDPResponseMessage
): { result?: CDPPayload; error?: string } | null {
  // Non-chunked response — return directly
  if (message.chunkIndex === undefined || message.totalChunks === undefined) {
    return { result: message.result, error: message.error };
  }

  // If this is an error during chunked transfer, abort and return error
  if (message.error) {
    buffers.delete(message.requestId);
    return { error: message.error };
  }

  const requestId = message.requestId;
  let buffer = buffers.get(requestId);
  if (!buffer) {
    buffer = {
      chunks: new Array(message.totalChunks),
      received: 0,
      totalChunks: message.totalChunks,
    };
    buffers.set(requestId, buffer);
  }

  // Store the chunk (supports out-of-order delivery)
  if (!buffer.chunks[message.chunkIndex]) {
    buffer.chunks[message.chunkIndex] = message.chunkData!;
    buffer.received++;
  }

  if (buffer.received >= buffer.totalChunks) {
    buffers.delete(requestId);
    try {
      const result = JSON.parse(buffer.chunks.join('')) as CDPPayload;
      return { result };
    } catch (err) {
      return {
        error: `Failed to reassemble CDP response: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return null; // Still waiting for more chunks
}
