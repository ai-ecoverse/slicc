/**
 * The owner's contract with one work unit.
 *
 * Owns: every hook the orchestrator/bridge hands a `ScoopContext` — response
 * streaming, tool events, scoop management, memory sinks, sudo routing.
 *
 * Changes when a surface is added to the runtime (a new tool family, a new
 * approval route). It is a pure type: keeping it beside the facade rather
 * than inside it means adding a hook no longer re-opens the runtime file.
 */

import type { BrowserAPI } from '../../cdp/index.js';
import type { CompactionState, CompactionStateDetail } from '../../core/context-compaction.js';
import type { ToolProgressEvent } from '../../shell/progress/types.js';
import type { AppendConeMemoryMeta } from '../cone-memory-store.js';
import type { RegisteredScoop } from '../types.js';

export interface ScoopContextCallbacks {
  onResponse: (text: string, isPartial: boolean) => void;
  onResponseDone: () => void;
  onError: (error: string) => void;
  /**
   * Called when a fatal error occurs that cannot be recovered via retry.
   * Unlike `onError`, this MUST bypass scoop_mute and notify the cone
   * immediately so the user is aware the scoop is dead.
   */
  onFatalError?: (error: string) => void;
  onStatusChange: (status: 'initializing' | 'ready' | 'processing' | 'error') => void;
  /** Called when a tool starts executing */
  onToolStart?: (toolName: string, toolInput: unknown, toolCallId?: string) => void;
  /** Called when a tool finishes executing */
  onToolEnd?: (toolName: string, result: string, isError: boolean, toolCallId?: string) => void;
  /** Called when a tool requests UI interaction */
  onToolUI?: (toolName: string, requestId: string, html: string) => void;
  /** Called when tool UI interaction is complete */
  onToolUIDone?: (requestId: string) => void;
  /** Called for each bash progress tick (`tool_progress` agent event). */
  onToolProgress?: (toolName: string, progress: ToolProgressEvent, toolCallId?: string) => void;
  /** Called when agent uses send_message tool */
  onSendMessage: (text: string, sender?: string) => void;
  /** Get all scoops (for cone) */
  getScoops: () => RegisteredScoop[];
  /** Get tab state for a scoop by JID (cone only). */
  getScoopTabState?: (jid: string) => import('../types.js').ScoopTabState | undefined;
  /** Feed a prompt to a specific scoop (cone only). */
  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  /** Create a new scoop (cone only) */
  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;
  /** Drop/remove a scoop (cone only) */
  onDropScoop?: (scoopJid: string) => Promise<void>;
  /** Mute scoops so their completions are not forwarded to the cone (cone only). */
  onMuteScoops?: (jids: readonly string[]) => void;
  /** Unmute scoops; returns any stashed completions so the caller can
   *  fold them into its tool result (cone only). */
  onUnmuteScoops?: (
    jids: readonly string[]
  ) => Promise<
    Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
  >;
  /** Schedule a non-blocking wait for a batch of scoops (cone only).
   *  Returns synchronously; the orchestrator emits a `scoop-wait` lick
   *  to the cone when all listed scoops complete or the timeout fires. */
  onScheduleScoopWait?: (
    jids: readonly string[],
    timeoutMs?: number
  ) => { scheduled: string[]; unknown: string[] };
  /**
   * Get `/shared/CLAUDE.md` content (the runtime instructions file
   * visible to all scoops). Auto-extracted memory does NOT land here —
   * see {@link appendConeMemory} for the cone-private sink.
   */
  getGlobalMemory: () => Promise<string>;
  /**
   * Update `/shared/CLAUDE.md` (cone only). Backs the explicit
   * `update_global_memory` tool surface; not used by the auto-extraction
   * pass (which routes through {@link appendConeMemory}).
   */
  setGlobalMemory?: (content: string) => Promise<void>;
  /**
   * Append auto-extracted memory bullets to the cone's own `CLAUDE.md` (cone
   * only). Called by the compaction memory-extraction pass. When omitted the
   * compaction pass skips its second LLM call entirely. The explicit-edit
   * surface for `/shared/CLAUDE.md` is the `update_global_memory` tool.
   *
   * `meta` may carry the active LLM model + credentials so the sink can
   * run a budget-driven restructure pass when an append overshoots the
   * size budget — see `cone-memory-budget.ts`. `meta.memoryPath` is bound by
   * `ScoopLifecycleManager` from the unit's record, not by the caller.
   */
  appendConeMemory?: (bullets: string, meta: AppendConeMemoryMeta) => Promise<void>;
  /**
   * Optional lifecycle hook for compaction. Emitted by the compaction
   * `transformContext` before and after each LLM call so the panel can
   * render a ghost-bubble affordance while the agent is silent.
   * `state === 'idle'` clears the affordance. `detail` carries the trigger
   * (threshold / overflow / idle) and the `/sessions` transcript path once
   * the pre-compaction snapshot has been written.
   */
  onCompactionStateChange?: (state: CompactionState, detail: CompactionStateDetail) => void;
  /**
   * Scoop-only: request a cone-mediated sudo escalation. Routes through the
   * orchestrator's pending-request registry and resolves with the cone's
   * decision (allow / always / deny), or `deny` on transport/timeout. The
   * cone keeps the user broker — only non-cone scoops wire this.
   */
  /**
   * Approve one tool call in a guest-caused turn. Routed by the request's
   * approver directive; absent means the gate cannot ask anyone, which the
   * caller must treat as a refusal.
   */
  approveGuestToolCall?: (
    request: import('../../sudo/types.js').SudoRequest
  ) => Promise<import('../../sudo/types.js').SudoDecision>;
  onSudoRequest?: (
    request: import('../../sudo/types.js').SudoRequest
  ) => Promise<import('../../sudo/types.js').SudoDecision>;
  /**
   * Cone-only: resolve a pending sudo request by id. On `'always'` the
   * orchestrator additionally persists a NOPASSWD rule into the requesting
   * scoop's `/scoops/<folder>/etc/sudoers` via the trusted manager sink.
   */
  onSudoResolve?: (
    id: string,
    decision: import('../../sudo/types.js').SudoDecision
  ) => Promise<{
    settled: boolean;
    persisted: boolean;
    persistedPattern?: string;
    persistError?: string;
    scoopFolder?: string;
    kind?: import('../../sudo/types.js').SudoRequest['kind'];
  }>;
  /** Cone-only: snapshot all pending cone-mediated sudo requests. */
  onListSudoRequests?: () => Array<{
    id: string;
    scoopJid: string;
    request: import('../../sudo/types.js').SudoRequest;
  }>;
  /** BrowserAPI provider for browser automation commands */
  getBrowserAPI: () => BrowserAPI;
}
