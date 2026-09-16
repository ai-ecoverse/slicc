import type { TraySudoAttestation, TraySudoDecision, TraySudoKind } from '@slicc/shared-ts';
import type { BrowserAPI } from '../../cdp/browser-api.js';
import type { CDPTransport } from '../../cdp/transport.js';
import type { MessageAttachment } from '../../core/attachments.js';
import type { VirtualFS } from '../../fs/virtual-fs.js';
import type { ExportSpool } from '../../transcript/export-spool.js';
import type { ChatMessage } from '../chat-types.js';
import type {
  ScoopSummary,
  SprinkleSummary,
  TrayModelCatalogEntry,
  TrayModelSelectionState,
  TraySyncCapabilities,
  TrayTargetEntry,
} from '../tray-sync-protocol.js';

export interface FollowerSyncManagerOptions {
  /**
   * A message this follower sent has moved through the leader's review gate.
   * Only ever called on a biscotto (guest seat) — an ordinary follower IS the
   * owner and its messages are not reviewed.
   */
  onBiscottoMessageState?: (
    messageId: string,
    state: 'pending' | 'approved' | 'rejected' | 'unanswered'
  ) => void;
  /** Called when the leader sends a snapshot (full state replacement). */
  onSnapshot?: (messages: ChatMessage[], scoopJid: string) => void;
  /** Called when the leader echoes a user message (local or from any follower). */
  onUserMessage?: (
    text: string,
    messageId: string,
    scoopJid: string,
    attachments?: MessageAttachment[]
  ) => void;
  /** Called when the leader sends a status update. scoopJid is absent for legacy leaders. */
  onStatus?: (scoopStatus: string, scoopJid?: string) => void;
  /** Called when the leader sends an updated target registry. */
  onTargetsUpdated?: (targets: TrayTargetEntry[]) => void;
  /** Optional CDP transport for executing local CDP commands (follower's browser). */
  browserTransport?: CDPTransport;
  /** Optional BrowserAPI instance for session-aware browser commands (e.g. cookie capture). */
  browserAPI?: BrowserAPI;
  /** Called when the leader data channel is considered dead (missed keepalive pongs). */
  onDead?: () => void;
  /** Called after the connection has been cleaned up due to keepalive death or channel failure. Higher-level code can use this to trigger reconnection. */
  onDisconnect?: (reason: string) => void;
  /**
   * Called with `true` when the leader stops answering keepalive pings while
   * its data channel is still open, and `false` when it answers again. The
   * connection is intact throughout — the leader is busy, not gone — so this
   * is a transient hint for connection UX, NOT a disconnect. Distinct from
   * `onDisconnect`, which fires only once the connection is really finished.
   */
  onLeaderStalled?: (stalled: boolean) => void;
  /** VirtualFS instance for handling remote fs requests targeting this follower. */
  vfs?: VirtualFS;
  /** Called when local browser targets may have changed (e.g. after a tab is opened or closed). */
  onTargetsChanged?: () => void;
  /** Called when the leader sends an updated sprinkle list. */
  onSprinklesList?: (sprinkles: SprinkleSummary[]) => void;
  /** Called when the leader sends an updated scoop list (nav bar / scoop picker). */
  onScoopsList?: (scoops: ScoopSummary[], activeScoopJid: string) => void;
  /** Called when a v5+ leader sends its credential-free selectable model catalog. */
  onModelsList?: (models: TrayModelCatalogEntry[]) => void;
  /** Called when a v5+ leader broadcasts the selected model and scoop thinking state. */
  onModelState?: (state: TrayModelSelectionState) => void;
  /** Called when the leader applies or clears its active theme. */
  onThemeApply?: (themeJson: string | null) => void;
  /** Called when the leader sends a `sprinkle.update` payload (mirrors `SprinkleManager.sendToSprinkle`). */
  onSprinkleUpdate?: (sprinkleName: string, data: unknown) => void;
  /** Called when the leader signals that a sprinkle's content has been reloaded (file changed). */
  onSprinkleReloaded?: (sprinkleName: string) => void;
  /**
   * Called when the leader sends a `cherry.slicc_event` (cone → host page). Only
   * a cherry follower wires this — it forwards the event to the host SDK via
   * `CherryHostTransport.emitSliccEventToHost`. Non-cherry followers leave it
   * unset, so the event falls through harmlessly. The wire `targetId` is not
   * forwarded: a cherry follower owns exactly one host transport, so the event
   * has only one destination.
   */
  onCherrySliccEvent?: (name: string, detail?: unknown) => void;
  /**
   * This follower's own runtime id, stamped onto outbound `cherry.host_event`
   * messages (host page → cone) so the cone-side lick records which cherry
   * runtime emitted it. The leader routes the event by connection identity, not
   * by this field, so it is informational only. Only a cherry follower sets it.
   */
  selfRuntimeId?: string;
  /**
   * Capabilities to advertise on the `hello` handshake (e.g. `browser: true`
   * for a follower whose local CDP transport can host teleported tabs).
   */
  helloCapabilities?: TraySyncCapabilities;
  /**
   * Show a leader-delegated OAuth login here (#1915) and resolve with the
   * terminal callback URL, or null when the human cancelled. Wired only by
   * floats with a window and a permissions surface; its presence is what
   * `capabilities.oauthPopup` advertises.
   */
  onOAuthPopupRequest?: (url: string, signal: AbortSignal) => Promise<string | null>;
  /**
   * Bound on every `fetchSprinkleContent` call. If the leader never
   * answers a `sprinkle.fetch` (deadlocked agent, partial chunked
   * transfer abandoned, leader still connected but stuck), the
   * follower would otherwise hang the controller's `opening` lock
   * forever. Defaults to 15 s. Pass `0` to disable this timer entirely,
   * or any positive value to override the default; non-positive /
   * non-finite inputs throw at construction.
   */
  sprinkleFetchTimeoutMs?: number;
  /**
   * Factory for creating export spools. Defaults to `makeExportSpool` which
   * returns an OpfsSpool in production and a MemorySpool as fallback.
   * Inject `() => new MemorySpool()` in tests for a deterministic, fast spool.
   */
  makeExportSpool?: (requestId: string) => ExportSpool;
  /**
   * Render a delegated sudo approval on behalf of the leader (issue #2062):
   * the leader is headless (hosted / cloud), or its human is driving from
   * here. Resolve the human's verdict; `pattern` only matters for `always`
   * (and the leader accepts `always` only from biometric-gated followers).
   *
   * When unset, or when it rejects, the follower replies `deny` — the gate is
   * fail-closed. `signal` aborts when the leader withdraws the prompt
   * (`sudo.approve.cancel`: someone else answered, or it timed out) or the
   * channel closes; implementations MUST close the dialog on abort.
   */
  onSudoApprovalRequest?: (request: {
    requestId: string;
    kind: TraySudoKind;
    detail: string;
    /** Leader-derived identity of the asker; chrome, not part of `detail`. */
    requester?: string;
    suggestedPattern?: string;
    /** The requester's stated "why", when given. Untrusted prose; render after `detail`. */
    reason?: string;
    scoopName?: string;
    expiresAt: number;
    signal: AbortSignal;
  }) => Promise<SudoApprovalVerdict> | SudoApprovalVerdict;
}

/** A follower-rendered sudo verdict. */
export interface SudoApprovalVerdict {
  decision: TraySudoDecision;
  pattern?: string;
  attestation?: TraySudoAttestation;
}
