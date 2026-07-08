/**
 * Agent/chat wire payload types embedded in the tray sync protocol
 * (`tray-sync-protocol.ts`) — the leader↔follower data-channel format
 * partially mirrored by the iOS follower
 * (`packages/ios-app/SliccFollower/Models/SyncProtocol.swift`).
 *
 * Types only — platform-agnostic by construction (no DOM, no Node, no
 * imports). The behavior that produces/consumes these shapes stays in
 * `@slicc/webapp` (`core/attachments.ts`, `core/agent-types.ts`,
 * `scoops/chat-types.ts`, `scoops/lick-manager.ts`), which re-exports them
 * so webapp-internal importers keep their layer-local import sites.
 */

// ---------------------------------------------------------------------------
// Message attachments
// ---------------------------------------------------------------------------

export type MessageAttachmentKind = 'image' | 'text' | 'file';

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: MessageAttachmentKind;
  /** Base64 payload for LLM-supported image attachments. */
  data?: string;
  /** UTF-8 content for text-like file attachments. */
  text?: string;
  /**
   * VFS path (e.g. `/tmp/attachment-…`) when the file was persisted to the
   * virtual filesystem because it was too large to inline. The agent can
   * `read_file`/`bash cat` this path to access the full content.
   */
  path?: string;
  /** Human-readable reason when the payload could not be included. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Agent events — emitted by the agent core, streamed to followers
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; messageId: string; text: string }
  | { type: 'content_done'; messageId: string }
  | { type: 'tool_use_start'; messageId: string; toolName: string; toolInput: unknown }
  | { type: 'tool_result'; messageId: string; toolName: string; result: string; isError?: boolean }
  | { type: 'tool_ui'; messageId: string; toolName: string; requestId: string; html: string }
  | { type: 'tool_ui_done'; messageId: string; requestId: string }
  | { type: 'turn_end'; messageId: string }
  | { type: 'error'; error: string }
  | { type: 'screenshot'; base64: string; url?: string }
  | { type: 'terminal_output'; text: string };

// ---------------------------------------------------------------------------
// Chat transcript shapes
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant';

/**
 * Result state of an actionable lick card (currently scoop sudo-requests):
 * `pending` (awaiting a decision — the default), `confirmed` (allowed), or
 * `dismissed` (denied). Drives the `<slicc-lick-card>` `state` attribute.
 */
export type LickState = 'pending' | 'confirmed' | 'dismissed';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  attachments?: MessageAttachment[];
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  /** Source of the message: 'cone' for main agent, scoop name for sub-agents, 'lick' for async events */
  source?: 'cone' | 'lick' | string;
  /** For licks: the channel type (webhook, cron, etc.) */
  channel?: string;
  /** Render-time collation: how many consecutive same-channel licks this row stands for. */
  lickCount?: number;
  /** Render-time collation: the individual lick bodies folded into this row. */
  lickParts?: string[];
  /**
   * For actionable licks (sudo-request): the orchestrator-minted lick id used
   * to locate this card when its decision settles, so the state can flip live.
   */
  lickId?: string;
  /** Result state for an actionable lick: pending / confirmed / dismissed. */
  lickState?: LickState;
  /** True when the message is queued (submitted while the agent is still processing). */
  queued?: boolean;
  /**
   * Cone-error marker — set by the chat controller's `error` AgentEvent
   * handler. The view renders this assistant message as a `slicc-error-card`
   * with a retry affordance instead of a plain assistant bubble.
   */
  error?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  /** Transient screenshot data URL — not persisted to session store. */
  _screenshotDataUrl?: string;
  /** Transient tool-UI request id used by `handleToolUI` to thread the
   *  approval/result roundtrip back to the offscreen agent. Not
   *  persisted. */
  _toolUIRequestId?: string;
}

// ---------------------------------------------------------------------------
// Lick events — external events routed to the cone
// ---------------------------------------------------------------------------

export interface LickEvent {
  type:
    | 'webhook'
    | 'cron'
    | 'sprinkle'
    | 'fswatch'
    | 'session-reload'
    | 'navigate'
    | 'upgrade'
    | 'cherry'
    | 'workflow'
    | 'sudo-request'
    | 'preview';
  webhookId?: string;
  webhookName?: string;
  cronId?: string;
  cronName?: string;
  sprinkleName?: string;
  /** For fswatch events */
  fswatchId?: string;
  fswatchName?: string;
  changes?: Array<{ type: string; path: string }>;
  /** For navigate events: the URL whose response advertised a SLICC handoff `Link` rel. */
  navigateUrl?: string;
  /** For upgrade events: the previously-seen and current bundled SLICC versions. */
  upgradeFromVersion?: string;
  upgradeToVersion?: string;
  /** For cherry events: the host-page event name, owning follower runtime, and host origin. */
  cherryName?: string;
  cherryRuntimeId?: string;
  cherryOrigin?: string;
  /** For preview events: the bridge connection metadata. */
  previewConnId?: string;
  previewOrigin?: string;
  previewToken?: string;
  previewUserAgent?: string;
  previewConnectedAt?: string;
  previewLifecycle?: 'connected' | 'disconnected';
  /**
   * Stable identifier for an actionable lick — one that the cone resolves via
   * the generic `lick_confirm` / `lick_dismiss` tools. Set by the
   * orchestrator's actionable-lick registry (see `ConeRequestRegistry`) and
   * carried through to the UI chip + formatter. For `sudo-request` events the
   * remaining `sudo*` fields mirror `SudoRequest` so the cone (or the user
   * reading the chip) can see what is being escalated. The actionable
   * agent-facing message is still delivered by
   * `Orchestrator.deliverSudoRequestToCone` — this lick is a UI-chip
   * notification only (see `defaultLickEventHandler` for the non-routing
   * branch).
   */
  lickId?: string;
  sudoKind?: string;
  sudoDetail?: string;
  sudoScoopName?: string;
  sudoSuggestedPattern?: string;
  targetScoop?: string;
  /**
   * Set ONLY by the leader when it re-emits a lick forwarded from a
   * follower. `originFollowerId` is the follower's bootstrapId (reserved
   * for future per-follower response routing); `originLabel` is a
   * human-readable source ("extension follower", "iOS follower", …)
   * to be surfaced to the agent by `formatLickEventForCone`.
   */
  originFollowerId?: string;
  originLabel?: string;
  /** Workflow completion (SP2): set by WorkflowRunManager on cone-origin runs. */
  workflowRunId?: string;
  workflowName?: string;
  resultPath?: string;
  preview?: string;
  timestamp: string;
  headers?: Record<string, string>;
  body: unknown;
}
