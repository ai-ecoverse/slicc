/**
 * Scoop Context - manages an isolated agent instance for a scoop.
 *
 * Each scoop gets:
 * - A restricted filesystem (shared VFS with path ACL)
 * - Its own AlmostBashShell
 * - Its own Agent instance
 * - Its own session history
 * - Skills loaded from VFS
 * - NanoClaw-style tools (send_message, scoop management)
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai';
import {
  getSupportedThinkingLevels,
  isContextOverflow,
  streamSimple,
} from '@earendil-works/pi-ai/compat';
import type { BrowserAPI } from '../cdp/index.js';
import { createCompactContext, stripOrphanedToolResults } from '../core/context-compaction.js';
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  AgentEvent as CoreAgentEvent,
  ImageContent,
  Model,
  TextContent,
} from '../core/index.js';
import { Agent, adaptTools, createLogger } from '../core/index.js';
import { fetchSecretEnvVars } from '../core/secret-env.js';
import { getToolResultScrubber } from '../core/secret-scrub.js';
import type { SessionStore } from '../core/session.js';
import { broadcastStaleAssetReload, isDynamicImportError } from '../core/stale-asset-channel.js';
import { emitAgentError } from '../core/telemetry-hook.js';
import type { VirtualFS } from '../fs/index.js';
import type { RestrictedFS } from '../fs/restricted-fs.js';
import { createSudoFs } from '../fs/sudo-fs.js';
import type { Process, ProcessManager } from '../kernel/process-manager.js';
import {
  getApiKey,
  getSelectedProvider,
  resolveCurrentModel,
  resolveModelById,
} from '../providers/account-store.js';
import { AlmostBashShell } from '../shell/index.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import { createBashTool, createFileTools } from '../tools/index.js';
import { getAdobeSessionId } from './llm-session-id.js';
import {
  createScoopManagementTools,
  type ScoopManagementToolsConfig,
} from './scoop-management-tools.js';
import { createDefaultSkills, formatSkillsForPrompt, loadSkills } from './skills.js';
import { type RegisteredScoop, THINKING_LEVELS } from './types.js';

const log = createLogger('scoop-context');

/**
 * Resolve a thinking level against an active model. Returns the value the
 * `Agent` should be initialized with — never throws.
 *
 * Rules:
 *   - Non-reasoning model → always `'off'`, regardless of `requested`.
 *   - `requested === undefined` → `'off'` (default; UI/CLI can opt in).
 *   - `requested === 'xhigh'` and the model does not advertise xhigh support
 *     (via `thinkingLevelMap`) → clamped to `'high'`.
 *   - Otherwise the requested value is passed through.
 *
 * Exposed for tests and re-used by `agent-bridge.ts`.
 */
export function resolveThinkingLevel(
  requested: ThinkingLevel | undefined,
  model: Model<Api>
): ThinkingLevel {
  if (!model.reasoning) return 'off';
  if (requested === undefined) return 'off';
  if (requested === 'xhigh' && !getSupportedThinkingLevels(model).includes('xhigh')) return 'high';
  return requested;
}

/**
 * Structural view of an `AgentMessage` used by the overflow / image recovery
 * passes. They walk every kind of message and only need `role` plus a list of
 * content blocks discriminated by `type` — narrower than the full union of
 * pi-ai message shapes, but enough to do the trimming safely without `any`.
 */
type RecoveryContentBlock = {
  type: string;
  text?: string;
  data?: string;
};
type RecoveryMessage = {
  role: string;
  content: RecoveryContentBlock[] | string;
};

/** Detect API errors caused by invalid/oversized images. */
export function isImageProcessingError(msg: string): boolean {
  return (
    /image exceeds.*maximum/i.test(msg) ||
    /Could not process image/i.test(msg) ||
    /invalid.*image/i.test(msg) ||
    /image.*too (large|big)/i.test(msg)
  );
}

/**
 * Detect errors that are unlikely to succeed on retry.
 * These include authentication failures, invalid model IDs, and permanent API errors.
 */
export function isNonRetryableError(msg: string): boolean {
  return (
    // HTTP 4xx errors (except 429 rate limit which is retryable)
    /\b(401|403|404|405|410|422)\b/.test(msg) ||
    // Authentication / authorization failures
    /unauthorized|forbidden|authentication.*failed|invalid.*api.?key/i.test(msg) ||
    // Expired session that needs interactive re-auth (won't succeed on retry)
    /session expired|log in again|re-?authenticate/i.test(msg) ||
    // Invalid model errors
    /model.*not.*found|invalid.*model|unknown.*model|does.*not.*exist/i.test(msg) ||
    // Decommissioned / deprecated / retired models (permanent provider-side 400s)
    /decommissioned|no longer supported|deprecated.*model|model.*deprecated|model.*retired/i.test(
      msg
    ) ||
    // Account/billing issues
    /insufficient.*quota|billing|payment.*required|account.*suspended/i.test(msg) ||
    // Malformed request (won't succeed on retry)
    /invalid.*request|malformed|bad.*request/i.test(msg)
  );
}

/**
 * Detect transient errors that may succeed on retry.
 * Includes rate limits, server errors, and network issues.
 */
export function isRetryableError(msg: string): boolean {
  return (
    // Rate limiting
    /\b429\b|rate.*limit|too.*many.*requests|quota.*exceeded/i.test(msg) ||
    // Server errors (5xx)
    /\b(500|502|503|504)\b|internal.*server|bad.*gateway|service.*unavailable|gateway.*timeout/i.test(
      msg
    ) ||
    // Network issues
    /network.*error|failed to fetch|connection.*refused|timeout|econnreset|socket.*hang.*up/i.test(
      msg
    ) ||
    // Temporary overload
    /overloaded|temporarily.*unavailable|try.*again/i.test(msg)
  );
}

/**
 * Sleep for `ms` milliseconds, resolving early when the given AbortSignal fires.
 * Returns `true` if the sleep was aborted, `false` if it completed normally.
 * Exposed for testing the retry loop's cooperative cancellation.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

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
  onToolStart?: (toolName: string, toolInput: unknown) => void;
  /** Called when a tool finishes executing */
  onToolEnd?: (toolName: string, result: string, isError: boolean) => void;
  /** Called when a tool requests UI interaction */
  onToolUI?: (toolName: string, requestId: string, html: string) => void;
  /** Called when tool UI interaction is complete */
  onToolUIDone?: (requestId: string) => void;
  /** Called when agent uses send_message tool */
  onSendMessage: (text: string, sender?: string) => void;
  /** Get all scoops (for cone) */
  getScoops: () => RegisteredScoop[];
  /** Get tab state for a scoop by JID (cone only). */
  getScoopTabState?: (jid: string) => import('./types.js').ScoopTabState | undefined;
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
   * Append auto-extracted memory bullets to /workspace/CLAUDE.md (cone only).
   * Called by the compaction memory-extraction pass. When omitted the
   * compaction pass skips its second LLM call entirely. The explicit-edit
   * surface for `/shared/CLAUDE.md` is the `update_global_memory` tool.
   *
   * `meta` may carry the active LLM model + credentials so the sink can
   * run a budget-driven restructure pass when an append overshoots the
   * size budget — see `cone-memory-budget.ts`.
   */
  appendConeMemory?: (
    bullets: string,
    meta: {
      source: string;
      model?: Model<Api>;
      apiKey?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ) => Promise<void>;
  /**
   * Optional lifecycle hook for compaction. Emitted by the compaction
   * `transformContext` before and after each LLM call so the panel can
   * render a ghost-bubble affordance while the agent is silent.
   * `state === 'idle'` clears the affordance.
   */
  onCompactionStateChange?: (state: 'summarizing' | 'extracting-memory' | 'idle') => void;
  /**
   * Scoop-only: request a cone-mediated sudo escalation. Routes through the
   * orchestrator's pending-request registry and resolves with the cone's
   * decision (allow / always / deny), or `deny` on transport/timeout. The
   * cone keeps the user broker — only non-cone scoops wire this.
   */
  onSudoRequest?: (
    request: import('../sudo/types.js').SudoRequest
  ) => Promise<import('../sudo/types.js').SudoDecision>;
  /**
   * Cone-only: resolve a pending sudo request by id. On `'always'` the
   * orchestrator additionally persists a NOPASSWD rule into the requesting
   * scoop's `/scoops/<folder>/etc/sudoers` via the trusted manager sink.
   */
  onSudoResolve?: (
    id: string,
    decision: import('../sudo/types.js').SudoDecision
  ) => Promise<{
    settled: boolean;
    persisted: boolean;
    persistedPattern?: string;
    persistError?: string;
    scoopFolder?: string;
    kind?: import('../sudo/types.js').SudoRequest['kind'];
  }>;
  /** Cone-only: snapshot all pending cone-mediated sudo requests. */
  onListSudoRequests?: () => Array<{
    id: string;
    scoopJid: string;
    request: import('../sudo/types.js').SudoRequest;
  }>;
  /** BrowserAPI provider for browser automation commands */
  getBrowserAPI: () => BrowserAPI;
}

export class ScoopContext {
  private scoop: RegisteredScoop;
  private callbacks: ScoopContextCallbacks;
  private fs: VirtualFS | RestrictedFS | null = null;
  private shell: AlmostBashShell | null = null;
  private agent: Agent | null = null;
  private status: 'initializing' | 'ready' | 'processing' | 'error' = 'initializing';
  private isProcessing = false;
  private disposed = false;
  private didStreamDeltas = false;
  private promptStreamErrorMessage: string | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Aborts the in-flight prompt() retry loop and any pending backoff sleep. */
  private promptAbortController: AbortController | null = null;
  /**
   * Process manager. When set, `prompt()` registers a
   * `kind:'scoop-turn'` process whose `Process.abort` is the same
   * controller as `promptAbortController`. `stop()` / `dispose()`
   * route through `pm.signal(pid, 'SIGINT')` so the recorded
   * `terminatedBy` and the exit code match the expected
   * scoop-turn aborted (130) shape.
   *
   * Optional — tests construct `ScoopContext` without a manager and
   * the existing inline-orchestrator path stays untouched. The
   * kernel-worker boot wires it through `createKernelHost`.
   */
  private processManager: ProcessManager | null = null;
  private currentTurnProcess: Process | null = null;

  private sessionStore: SessionStore | null = null;
  private sessionId: string;
  private sessionCreatedAt: number = 0;
  private isRecovering: 'overflow' | 'image' | false = false;
  private coneJid: string | undefined;

  private skillsFs: VirtualFS | null = null;
  private skillsDir: string = '/workspace/skills';
  private sudoManager: SudoManager | null = null;

  private structuredOutputValue: unknown;
  private structuredOutputCaptured = false;

  constructor(
    scoop: RegisteredScoop,
    callbacks: ScoopContextCallbacks,
    fs: VirtualFS | RestrictedFS,
    sessionStore?: SessionStore,
    skillsFs?: VirtualFS,
    coneJid?: string,
    processManager?: ProcessManager,
    sudoManager?: SudoManager | null
  ) {
    this.scoop = scoop;
    this.callbacks = callbacks;
    this.fs = fs;
    this.sessionStore = sessionStore ?? null;
    this.skillsFs = skillsFs ?? null;
    this.coneJid = coneJid;
    this.processManager = processManager ?? null;
    this.sudoManager = sudoManager ?? null;
    // Internal persistence key — stable across days/restarts so saved
    // conversations can be restored by `SessionStore.load`. The outgoing
    // Adobe `X-Session-Id` is computed separately in `init()`.
    this.sessionId = scoop.jid;
  }

  getStructuredOutput() {
    return { captured: this.structuredOutputCaptured, value: this.structuredOutputValue };
  }

  /**
   * Assemble the sudo enforcement surface for this scoop: the `SudoFS` broker
   * + policy getter + default disposition, plus a matching `ShellSudoConfig`.
   * Cones keep the user broker, the global policy, and `'allow'` default
   * (unchanged behavior — only explicit `/etc/sudoers` rules gate). Non-cone
   * scoops use the cone-mediated broker wired via {@link ScoopContextCallbacks.onSudoRequest},
   * the per-scoop policy from {@link SudoManager.getPolicyForScoop}, and
   * `'require-approval'` default so unmatched writes / commands escalate.
   * Returns `null` only when no `SudoManager` is available (tests, ad-hoc
   * sub-shells) — the agent is fully ungated in that path, same as before.
   */
  private buildSudoWiring(): {
    broker: import('../sudo/types.js').SudoBroker;
    getPolicy: () => import('../shell/sudo/sudoers.js').SudoersPolicy;
    defaultDisposition: import('../shell/sudo/sudoers.js').DefaultDisposition;
    shellConfig: import('../shell/almost-bash-shell-headless.js').ShellSudoConfig;
  } | null {
    if (!this.sudoManager) return null;
    const manager = this.sudoManager;
    const isCone = this.scoop.isCone;
    const folder = this.scoop.folder;
    const coneBrokerFn = this.callbacks.onSudoRequest;

    const broker: import('../sudo/types.js').SudoBroker =
      isCone || !coneBrokerFn
        ? manager.getBroker()
        : { requestApproval: (request) => coneBrokerFn(request) };
    const getPolicy = isCone ? () => manager.getPolicy() : () => manager.getPolicyForScoop(folder);
    const defaultDisposition: import('../shell/sudo/sudoers.js').DefaultDisposition = isCone
      ? 'allow'
      : 'require-approval';

    const baseShell = manager.getShellConfig();
    // Cones inherit the global `persistCommandGrant` sink (writes to
    // `/etc/sudoers.d/granted` — visible to every scoop). Non-cone scoops
    // MUST NOT use that sink: a scoop-A "Always" approval would land as a
    // NOPASSWD rule for every scoop. The cone-mediated `always` decision
    // already persists scoped via `Orchestrator.resolveSudoRequestAndPersist`
    // → `SudoManager.appendScoopRule`, so the shell-side sink is a no-op
    // for non-cone scoops here.
    const persistCommandGrant = isCone ? baseShell.persistCommandGrant : async () => {};
    const shellConfig: import('../shell/almost-bash-shell-headless.js').ShellSudoConfig = {
      ...baseShell,
      broker,
      getPolicy,
      defaultDisposition,
      persistCommandGrant,
    };
    return { broker, getPolicy, defaultDisposition, shellConfig };
  }

  /** Create shell and load skills. */
  private async initShellAndSkills() {
    const cwd = this.scoop.isCone ? '/workspace' : `/scoops/${this.scoop.folder}/workspace`;
    const browser = this.callbacks.getBrowserAPI();
    this.skillsDir = '/workspace/skills';

    if (this.scoop.isCone) {
      await createDefaultSkills(this.fs as VirtualFS, this.skillsDir);
    }

    const effectiveSkillsFs = (this.skillsFs ?? this.fs) as VirtualFS;
    const secretEnv = await fetchSecretEnvVars();

    // Wire the sudo enforcement surface. For non-cone scoops the broker
    // routes to the cone (via the `onSudoRequest` callback the orchestrator
    // already hooked up — same wire as `createConeApprovalBroker`), the
    // policy is the per-scoop merge (global ∪ `/scoops/<folder>/etc/sudoers`),
    // and the default disposition is `'require-approval'` so any unmatched
    // write OR command escalates to the cone instead of dying with a hard
    // wall. The cone keeps the user broker + `'allow'` default — unchanged.
    const sudoWiring = this.buildSudoWiring();
    const gatedFs = (
      sudoWiring
        ? createSudoFs(this.fs!, {
            broker: sudoWiring.broker,
            getPolicy: sudoWiring.getPolicy,
            defaultDisposition: sudoWiring.defaultDisposition,
          })
        : this.fs!
    ) as VirtualFS;

    this.shell = new AlmostBashShell({
      fs: gatedFs,
      cwd,
      env: Object.keys(secretEnv).length > 0 ? secretEnv : undefined,
      browserAPI: browser,
      jshDiscoveryFs: this.skillsFs ? effectiveSkillsFs : undefined,
      allowedCommands: this.scoop.config?.allowedCommands,
      getParentJid: () => this.scoop.jid,
      isScoop: () => !this.scoop.isCone,
      sudo: sudoWiring?.shellConfig,
      // Wire the scoop's process context so realm-backed commands (`node` /
      // `.jsh` / `python`) launched by the agent's `bash` tool parent their
      // realm child to the scoop-turn pid. Without this `buildJshProcessConfig`
      // returns `undefined` and the realm child registers at `ppid:1`, so the
      // `stop()`/`dispose()`/`drop_scoop` fan-out from the `kind:'scoop-turn'`
      // pid never reaches it and it survives the turn (#1166).
      processManager: this.processManager ?? undefined,
      processOwner: {
        kind: this.scoop.isCone ? 'cone' : 'scoop',
        scoopJid: this.scoop.jid,
      },
      getCurrentShellPid: () => this.currentTurnProcess?.pid,
    });

    log.info('AlmostBashShell initialized', { folder: this.scoop.folder });
    const skills = await loadSkills(effectiveSkillsFs, this.skillsDir);
    return { gatedFs, skills };
  }

  /** Build tools for the agent. */
  private async buildTools(gatedFs: VirtualFS) {
    const scoopManagementToolsConfig: ScoopManagementToolsConfig = {
      scoop: this.scoop,
      onSendMessage: this.callbacks.onSendMessage,
      getScoops: this.callbacks.getScoops,
      getScoopTabState: this.callbacks.getScoopTabState,
      onFeedScoop: this.callbacks.onFeedScoop,
      onScoopScoop: this.callbacks.onScoopScoop,
      onDropScoop: this.callbacks.onDropScoop,
      onMuteScoops: this.callbacks.onMuteScoops,
      onUnmuteScoops: this.callbacks.onUnmuteScoops,
      onScheduleScoopWait: this.callbacks.onScheduleScoopWait,
      onSetGlobalMemory: this.callbacks.setGlobalMemory,
      getGlobalMemory: this.callbacks.getGlobalMemory,
      onSudoRequest: this.callbacks.onSudoRequest,
      onSudoResolve: this.callbacks.onSudoResolve,
      onListSudoRequests: this.callbacks.onListSudoRequests,
    };
    const scoopManagementTools = createScoopManagementTools(scoopManagementToolsConfig);

    const legacyTools = [
      ...createFileTools(gatedFs),
      createBashTool(this.shell!),
      ...scoopManagementTools,
    ];

    if (this.scoop.config?.structuredOutputSchema) {
      const { createStructuredOutputTool } = await import('./structured-output-tool.js');
      legacyTools.push(
        createStructuredOutputTool(this.scoop.config.structuredOutputSchema, (v) => {
          this.structuredOutputValue = v;
          this.structuredOutputCaptured = true;
        })
      );
    }

    const secretsConfig = { scrubToolResult: getToolResultScrubber() };
    return this.processManager
      ? adaptTools(
          legacyTools,
          {
            processManager: this.processManager,
            owner: {
              kind: this.scoop.isCone ? 'cone' : 'scoop',
              scoopJid: this.scoop.jid,
            },
            getParentPid: () => this.currentTurnProcess?.pid,
          },
          secretsConfig
        )
      : adaptTools(legacyTools, undefined, secretsConfig);
  }

  /** Load scoop memory and global memory. */
  private async loadMemories() {
    const memoryPath = this.scoop.isCone
      ? '/workspace/CLAUDE.md'
      : `/scoops/${this.scoop.folder}/CLAUDE.md`;
    let scoopMemory = '';
    try {
      const content = await this.fs!.readFile(memoryPath, { encoding: 'utf-8' });
      scoopMemory = typeof content === 'string' ? content : new TextDecoder().decode(content);
    } catch {
      // No memory file yet
    }

    const globalMemory = await this.callbacks.getGlobalMemory();
    if (globalMemory && this.scoop.isCone) {
      try {
        const underlying =
          'getUnderlyingFS' in this.fs!
            ? (this.fs! as RestrictedFS).getUnderlyingFS()
            : (this.fs! as VirtualFS);
        await underlying.writeFile('/shared/CLAUDE.md', globalMemory);
      } catch {
        // /shared may not be accessible
      }
    }

    return { scoopMemory, globalMemory };
  }

  /** Restore agent session from storage. */
  private async restoreSession(): Promise<AgentMessage[]> {
    if (!this.sessionStore) return [];

    try {
      const saved = await this.sessionStore.load(this.sessionId);
      if (saved) {
        const restoredMessages = stripOrphanedToolResults(saved.messages);
        this.sessionCreatedAt = saved.createdAt;
        log.info('Restored agent session', {
          folder: this.scoop.folder,
          messageCount: restoredMessages.length,
          droppedOrphans: saved.messages.length - restoredMessages.length,
        });
        return restoredMessages;
      }
    } catch (err) {
      log.error('Failed to restore agent session', {
        folder: this.scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      this.callbacks.onError(`Conversation history could not be restored. Starting fresh.`);
    }
    return [];
  }

  /** Build Adobe session ID and streaming/compaction helpers. */
  private async buildSessionHelpers(model: Model<Api>) {
    const adobeSessionId = await getAdobeSessionId(this.scoop, this.coneJid);
    const streamWithSessionId: typeof streamSimple = (m, ctx, opts) => {
      if (m.provider !== 'adobe') return streamSimple(m, ctx, opts);
      return streamSimple(m, ctx, {
        ...opts,
        headers: { ...opts?.headers, 'X-Session-Id': adobeSessionId },
      });
    };

    const compactionHeaders =
      model.provider === 'adobe' ? { 'X-Session-Id': adobeSessionId } : undefined;
    const onMemoryUpdates =
      this.scoop.isCone && this.callbacks.appendConeMemory
        ? (bullets: string) =>
            this.callbacks.appendConeMemory!(bullets, {
              source: 'compaction',
              model,
              apiKey: getApiKey() ?? undefined,
              headers: compactionHeaders,
            })
        : undefined;

    const compactFn = createCompactContext({
      model,
      contextWindow:
        typeof model.contextWindow === 'number' && model.contextWindow > 0
          ? model.contextWindow
          : undefined,
      getApiKey: () => getApiKey() ?? undefined,
      headers: compactionHeaders,
      onMemoryUpdates,
      onCompactionStateChange: this.callbacks.onCompactionStateChange,
    });

    return { streamWithSessionId, compactFn };
  }

  /** Initialize the scoop's environment */
  async init(): Promise<void> {
    this.setStatus('initializing');

    try {
      if (!this.fs) throw new Error('Filesystem not provided');

      log.info('Filesystem ready', { folder: this.scoop.folder });
      await this.ensureDirectoryStructure();

      const { gatedFs, skills } = await this.initShellAndSkills();
      const tools = await this.buildTools(gatedFs);
      const { scoopMemory, globalMemory } = await this.loadMemories();

      const apiKey = getApiKey();
      if (!apiKey) {
        log.info('ScoopContext init deferred — no API key yet', {
          folder: this.scoop.folder,
        });
        this.setStatus('ready');
        return;
      }

      const model = this.scoop.config?.modelId
        ? resolveModelById(this.scoop.config.modelId)
        : resolveCurrentModel();
      const label = this.scoop.isCone ? 'Cone' : `Scoop "${this.scoop.name}"`;
      console.log(`[model] ${label} using model: ${model.id} (provider: ${model.provider})`);

      const systemPrompt = this.buildSystemPrompt(globalMemory, scoopMemory, skills);
      const restoredMessages = await this.restoreSession();
      const { streamWithSessionId, compactFn } = await this.buildSessionHelpers(model);

      if (this.disposed) return;

      const lockedEffort = this.getLockedEffortLevel();
      const thinkingLevel = resolveThinkingLevel(
        lockedEffort ?? this.scoop.config?.thinkingLevel,
        model
      );

      this.agent = new Agent({
        initialState: {
          model,
          tools,
          systemPrompt,
          messages: restoredMessages,
          thinkingLevel,
        },
        getApiKey: () => getApiKey() ?? undefined,
        transformContext: compactFn,
        streamFn: streamWithSessionId,
        afterToolCall: async (context) => {
          if (
            this.scoop.config?.structuredOutputSchema &&
            context.toolCall.name === 'StructuredOutput'
          ) {
            this.structuredOutputValue = context.args;
            this.structuredOutputCaptured = true;
          }
          return undefined;
        },
      });

      this.unsubscribe = this.agent.subscribe((event) => this.handleAgentEvent(event));

      this.setStatus('ready');
      log.info('ScoopContext initialized', { folder: this.scoop.folder, toolCount: tools.length });
    } catch (err) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      log.error('ScoopContext init failed', { folder: this.scoop.folder, error: message });
      this.setStatus('error');
      this.callbacks.onError(`Failed to initialize: ${message}`);
    }
  }

  /** Ensure agent is initialized. Returns false if initialization failed. */
  private async ensureAgentReady(): Promise<boolean> {
    if (this.agent) return true;

    await this.init();
    if (!this.agent) {
      let provider = '';
      try {
        provider = getSelectedProvider();
      } catch {
        /* test env may have no localStorage — fall back to a generic message */
      }
      this.callbacks.onError(
        provider
          ? `No API key configured for provider "${provider}". Open Settings to add one.`
          : 'No API key configured. Open Settings to add one.'
      );
      return false;
    }
    return true;
  }

  /** Queue prompt if agent is busy. Returns true if queued. */
  private queuePromptIfBusy(text: string, images: ImageContent[]): boolean {
    const agentIsStreaming = this.agent!.state?.isStreaming ?? false;
    if (this.isProcessing || agentIsStreaming) {
      log.info('Queueing prompt via followUp while processing', {
        folder: this.scoop.folder,
        isProcessing: this.isProcessing,
        agentIsStreaming,
      });
      this.agent!.followUp({
        role: 'user',
        content: [{ type: 'text', text }, ...images],
        timestamp: Date.now(),
      });
      return true;
    }
    return false;
  }

  /** Register turn process with process manager. */
  private registerTurnProcess(text: string, abortController: AbortController): Process | null {
    if (!this.processManager) return null;

    const turnArgv = ['prompt', text.length > 200 ? text.slice(0, 197) + '…' : text];
    return this.processManager.spawn({
      kind: 'scoop-turn',
      argv: turnArgv,
      cwd: this.scoop.isCone ? '/workspace' : `/scoops/${this.scoop.folder}/workspace`,
      owner: {
        kind: this.scoop.isCone ? 'cone' : 'scoop',
        scoopJid: this.scoop.jid,
      },
      adoptAbort: abortController,
    });
  }

  /** Handle non-retryable error. Returns true if handled. */
  private handleNonRetryableError(message: string): boolean {
    if (!isNonRetryableError(message)) return false;

    log.error('Non-retryable agent error', {
      folder: this.scoop.folder,
      error: message,
    });
    emitAgentError('llm', message);
    this.setStatus('error');
    if (this.callbacks.onFatalError) {
      this.callbacks.onFatalError(
        `Scoop "${this.scoop.name}" failed with unrecoverable error: ${message}`
      );
    } else {
      this.callbacks.onError(message);
    }
    return true;
  }

  /**
   * Handle a stale-asset import failure (#1330). A gone content-hashed chunk
   * after a deploy — retrying the cached-failed import is futile (checked BEFORE
   * the retry matcher, which also matches "failed to fetch"), so ask the owning
   * page to reload (guarded) and surface as fatal. Returns true if handled.
   */
  private handleStaleAssetError(message: string): boolean {
    if (!isDynamicImportError(message)) return false;
    log.error('Stale-asset import failure; requesting page reload', {
      folder: this.scoop.folder,
      error: message,
    });
    // Only a CONE turn is user-resubmittable — pass isCone so the page marks
    // the dropped turn for one-shot auto-resubmit after the recovery reload.
    // Scoop turns are cone-delegated; they broadcast (false) to reload but are
    // never replayed.
    broadcastStaleAssetReload(this.scoop.isCone);
    emitAgentError('llm', message);
    this.setStatus('error');
    if (this.callbacks.onFatalError) {
      this.callbacks.onFatalError(
        `Scoop "${this.scoop.name}" hit a stale build after a deploy; reloading to recover.`
      );
    } else {
      this.callbacks.onError(message);
    }
    return true;
  }

  /** Handle retryable error with exponential backoff. Returns true if should retry. */
  private async handleRetryableError(
    message: string,
    attempt: number,
    maxRetries: number,
    baseDelayMs: number,
    abortSignal: AbortSignal
  ): Promise<boolean> {
    if (!isRetryableError(message) || attempt >= maxRetries) return false;

    const delay = baseDelayMs * Math.pow(2, attempt - 1);
    log.warn('Retryable agent error, will retry', {
      folder: this.scoop.folder,
      error: message,
      attempt,
      maxRetries,
      delayMs: delay,
    });
    const aborted = await abortableSleep(delay, abortSignal);
    return !aborted && !this.disposed;
  }

  /** Handle final error after retries exhausted. */
  private handleExhaustedRetries(error: Error, maxRetries: number): void {
    const message = error.message;
    log.error('Agent error after retries exhausted', {
      folder: this.scoop.folder,
      error: message,
      maxRetries,
    });
    emitAgentError('llm', message);
    this.setStatus('error');
    if (this.callbacks.onFatalError) {
      this.callbacks.onFatalError(
        `Scoop "${this.scoop.name}" failed after ${maxRetries} attempts: ${message}`
      );
    } else {
      this.callbacks.onError(message);
    }
  }

  /** Clean up turn process and state. */
  private cleanupPromptState(
    abortController: AbortController,
    turnProcess: Process | null,
    lastError: Error | null,
    abortSignal: AbortSignal
  ): void {
    this.isProcessing = false;
    if (!this.disposed && this.status === 'processing') {
      this.setStatus('ready');
    }
    if (this.promptAbortController === abortController) {
      this.promptAbortController = null;
    }
    if (turnProcess && this.processManager) {
      if (lastError && !abortSignal.aborted) {
        this.processManager.exit(turnProcess.pid, 1);
      } else {
        this.processManager.exit(turnProcess.pid, abortSignal.aborted ? null : 0);
      }
    }
    if (this.currentTurnProcess === turnProcess) {
      this.currentTurnProcess = null;
    }
  }

  /** Try a single agent prompt attempt. Returns error or null on success. */
  private async tryAgentPrompt(
    agent: Agent,
    text: string,
    images: ImageContent[]
  ): Promise<Error | null> {
    this.didStreamDeltas = false;
    this.promptStreamErrorMessage = null;
    try {
      await agent.prompt(text, images);
      if (this.promptStreamErrorMessage) {
        return new Error(this.promptStreamErrorMessage);
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Handle error after a failed attempt. Returns true if should return early. */
  private async handlePromptAttemptError(
    error: Error,
    attempt: number,
    maxRetries: number,
    baseDelayMs: number,
    abortSignal: AbortSignal
  ): Promise<boolean> {
    const message = error.message;

    if (this.handleStaleAssetError(message)) return true;
    if (this.handleNonRetryableError(message)) return true;

    const shouldRetry = await this.handleRetryableError(
      message,
      attempt,
      maxRetries,
      baseDelayMs,
      abortSignal
    );
    if (shouldRetry) return false;

    log.error('Agent error', {
      folder: this.scoop.folder,
      error: message,
      attempt,
      isRetryable: isRetryableError(message),
    });

    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const aborted = await abortableSleep(delay, abortSignal);
      if (aborted || this.disposed) return true;
    }

    return false;
  }

  /** Run agent prompt with retry loop. Returns the last error if any. */
  private async runAgentWithRetries(
    agent: Agent,
    text: string,
    images: ImageContent[],
    abortSignal: AbortSignal
  ): Promise<Error | null> {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.disposed || abortSignal.aborted) return null;

      const error = await this.tryAgentPrompt(agent, text, images);
      if (!error) return null;

      if (this.disposed || abortSignal.aborted) return null;

      lastError = error;
      const shouldReturn = await this.handlePromptAttemptError(
        error,
        attempt,
        MAX_RETRIES,
        BASE_DELAY_MS,
        abortSignal
      );
      if (shouldReturn) return null;
    }

    return lastError;
  }

  /** Send a prompt to this scoop's agent. If already processing, queues it via followUp(). */
  async prompt(text: string, images: ImageContent[] = []): Promise<void> {
    if (!(await this.ensureAgentReady())) return;
    if (this.queuePromptIfBusy(text, images)) return;

    const agent = this.agent!;

    this.promptAbortController?.abort();
    const abortController = new AbortController();
    this.promptAbortController = abortController;
    const abortSignal = abortController.signal;

    this.isProcessing = true;
    this.setStatus('processing');

    const turnProcess = this.registerTurnProcess(text, abortController);
    this.currentTurnProcess = turnProcess;

    // Hoisted so the `finally` can thread it into cleanupPromptState, which uses
    // it to set the turn process exit code (1 on failure, 0 on clean completion).
    let lastError: Error | null = null;
    try {
      lastError = await this.runAgentWithRetries(agent, text, images, abortSignal);

      if (lastError && !this.disposed && !abortSignal.aborted) {
        this.handleExhaustedRetries(lastError, 3);
        return;
      }

      // Only set 'ready' if status hasn't been changed to 'error' by a fatal handler.
      // handleNonRetryableError sets 'error' before returning, so we preserve that.
      if (!this.disposed && !abortSignal.aborted && this.status !== 'error') {
        this.setStatus('ready');
      }
    } finally {
      this.cleanupPromptState(abortController, turnProcess, lastError, abortSignal);
    }
  }

  /** Stop the current agent operation and clear any queued prompts */
  stop(): void {
    // Route the abort through `pm.signal` first so the turn
    // process records `terminatedBy: 'SIGINT'` before we abort
    // the controller (the abort would still fire because
    // `signal()` calls `controller.abort()` internally — but
    // doing it via the manager keeps the recorded state consistent).
    if (this.currentTurnProcess && this.processManager) {
      this.processManager.signal(this.currentTurnProcess.pid, 'SIGINT');
    } else {
      this.promptAbortController?.abort();
    }
    this.agent?.clearAllQueues?.();
    this.agent?.abort?.();
    this.isProcessing = false;
    this.setStatus('ready');
  }

  /** Clear the agent's in-memory conversation history (used by clear-chat). */
  clearMessages(): void {
    if (this.agent) {
      this.agent.state.messages = [];
    }
  }

  /** Get the agent's current in-memory messages (for diagnostics). */
  getAgentMessages(): AgentMessage[] {
    return this.agent?.state?.messages ? structuredClone(this.agent.state.messages) : [];
  }

  /**
   * 0..1 estimate of how full the model's context window is, from the LAST
   * assistant turn's reported usage — `input + cacheRead` is the prompt the
   * model actually saw (output is what it added). 0 before the first turn.
   */
  getContextFill(): number {
    const messages = this.agent?.state?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as {
        role?: string;
        usage?: { input: number; output: number; cacheRead: number };
      };
      if (msg.role !== 'assistant' || !msg.usage) continue;
      const used = msg.usage.input + msg.usage.cacheRead + msg.usage.output;
      let window = 200_000;
      try {
        const model = this.scoop.config?.modelId
          ? resolveModelById(this.scoop.config.modelId)
          : resolveCurrentModel();
        if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
          window = model.contextWindow;
        }
      } catch {
        // Model resolution is best-effort here; the default window stands.
      }
      return Math.min(1, used / window);
    }
    return 0;
  }

  /** Get the session ID used for agent-sessions DB persistence. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Get the scoop's filesystem */
  getFS(): VirtualFS | RestrictedFS | null {
    return this.fs;
  }

  /** Get the scoop's shell */
  getShell(): AlmostBashShell | null {
    return this.shell;
  }

  /**
   * Update the model on the running agent (e.g. when the user changes
   * the model dropdown).
   *
   * Also re-resolves the running thinking-level against the new model:
   * `xhigh` clamps down to `high` on a model family that doesn't
   * advertise xhigh, and any non-`off` level snaps to `off` on a
   * non-reasoning model. The persisted `scoop.config.thinkingLevel`
   * stays untouched so the user's intent is preserved across model
   * swaps — the resolver re-evaluates it on every change.
   */
  updateModel(): void {
    if (!this.agent) return;
    const model = resolveCurrentModel();
    this.agent.state.model = model;
    // Re-resolve the active thinking level against the new model. Read
    // the user's *intent* off the persisted scoop config (not
    // `agent.state.thinkingLevel`, which would already have been
    // clamped by a previous resolution) so a model swap that re-enables
    // a higher tier (e.g. switching to an xhigh-capable Opus) restores
    // it instead of leaving the previously-clamped value in place.
    const lockedEffort = this.getLockedEffortLevel();
    const requested = lockedEffort ?? this.scoop.config?.thinkingLevel;
    this.agent.state.thinkingLevel = resolveThinkingLevel(requested, model);
    log.info('Model updated on running agent', {
      folder: this.scoop.folder,
      model: model.id,
      thinkingLevel: this.agent.state.thinkingLevel,
    });
  }

  /** Hot-reload skills from VFS and update the agent's system prompt. */
  async reloadSkills(): Promise<void> {
    if (!this.agent) return;

    const effectiveSkillsFs = (this.skillsFs ?? this.fs) as VirtualFS;
    const skills = await loadSkills(effectiveSkillsFs, this.skillsDir);

    // Re-read memories for prompt rebuild
    let scoopMemory = '';
    const memoryPath = this.scoop.isCone
      ? '/workspace/CLAUDE.md'
      : `/scoops/${this.scoop.folder}/CLAUDE.md`;
    try {
      const content = await this.fs!.readFile(memoryPath, { encoding: 'utf-8' });
      scoopMemory = typeof content === 'string' ? content : new TextDecoder().decode(content);
    } catch {
      /* no memory file -- expected for fresh scoops */
    }

    const globalMemory = await this.callbacks.getGlobalMemory();

    const newPrompt = this.buildSystemPrompt(globalMemory, scoopMemory, skills);
    this.agent.state.systemPrompt = newPrompt;

    log.info('Skills reloaded', {
      folder: this.scoop.folder,
      skillCount: skills.length,
    });
  }

  /**
   * Update the active reasoning/thinking level for this scoop.
   *
   * Mutates `agent.state.thinkingLevel` directly (it's writable on
   * pi-agent-core's `AgentState`), so the next assistant turn picks up the
   * change without restarting the agent. The caller is responsible for
   * persisting `scoop.config.thinkingLevel` separately if the change should
   * survive a reload — `Orchestrator.updateScoopConfig` handles that.
   *
   * Returns the level actually applied, after model-aware resolution
   * (xhigh→high clamp on unsupported models, off on non-reasoning models).
   */
  setThinkingLevel(level: ThinkingLevel | undefined): ThinkingLevel {
    if (!this.agent) return 'off';
    const locked = this.getLockedEffortLevel();
    if (locked) return this.agent.state.thinkingLevel;
    const resolved = resolveThinkingLevel(level, this.agent.state.model);
    this.agent.state.thinkingLevel = resolved;
    return resolved;
  }

  private getLockedEffortLevel(): ThinkingLevel | null {
    try {
      const val = localStorage.getItem('slicc_locked_effort_level');
      if (!val) return null;
      if (THINKING_LEVELS.includes(val as ThinkingLevel)) return val as ThinkingLevel;
      log.warn('Unrecognized locked effort level in localStorage, ignoring:', val);
    } catch {
      // Worker shim or test env may not have localStorage
    }
    return null;
  }

  /** Currently applied thinking level on the running agent. */
  getThinkingLevel(): ThinkingLevel {
    return this.agent?.state.thinkingLevel ?? 'off';
  }

  /** Cleanup */
  dispose(): void {
    this.disposed = true;
    // Cancel any in-flight retry loop / backoff sleep before tearing down the agent.
    if (this.currentTurnProcess && this.processManager) {
      // SIGTERM matches the conventional shutdown semantic — the
      // turn loop's `finally` block will run `pm.exit(pid, null)`
      // and the manager derives the 143 exit code from terminatedBy.
      this.processManager.signal(this.currentTurnProcess.pid, 'SIGTERM');
    } else {
      this.promptAbortController?.abort();
    }
    this.promptAbortController = null;
    this.agent?.clearAllQueues?.();
    this.agent?.abort?.();
    this.unsubscribe?.();
    // Drop the closure reference, not just call it: the unsubscribe
    // closure returned by `agent.subscribe()` captures the Agent (and
    // through it the full message history, tool results included).
    // Nulling `this.agent` alone leaves that history reachable through
    // this field for as long as anything retains the disposed context.
    this.unsubscribe = null;
    this.shell?.dispose();
    this.agent = null;
    this.shell = null;
    this.fs = null;
  }

  private setStatus(status: 'initializing' | 'ready' | 'processing' | 'error'): void {
    if (this.disposed) return;
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  /** Handle tool UI events. */
  private handleToolUIEvents(event: { partialResult: unknown; toolName: string }): void {
    const partialResult = event.partialResult as {
      content?: Array<{ type: string; requestId?: string; html?: string }>;
    };
    for (const c of partialResult?.content ?? []) {
      if (c.type === 'tool_ui' && c.requestId && c.html) {
        this.callbacks.onToolUI?.(event.toolName, c.requestId, c.html);
      } else if (c.type === 'tool_ui_done' && c.requestId) {
        this.callbacks.onToolUIDone?.(c.requestId);
      }
    }
  }

  /** Handle tool result formatting. */
  private formatToolResult(event: { result: unknown; toolName: string; isError: boolean }): void {
    const result = event.result as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
    const parts: string[] = [];
    for (const c of result?.content ?? []) {
      if (c.type === 'text' && c.text) parts.push(c.text);
      if (c.type === 'image' && c.data && c.mimeType)
        parts.push(`<img:data:${c.mimeType};base64,${c.data}>`);
    }
    const joined = parts.join('\n');
    if (event.isError) {
      // Telemetry is best-effort — `target` is sanitized+truncated by
      // `trackError` downstream so passing the raw text excerpt is safe.
      // Strip `<img:data:...;base64,...>` parts before emitting: their
      // base64 payload can run into MBs per failed image-emitting tool
      // call, and the telemetry sink only truncates downstream on the
      // wire. The full `joined` (images included) still flows to the
      // onToolEnd callback unchanged.
      const telemetryText = parts.filter((p) => !p.startsWith('<img:')).join('\n');
      emitAgentError('tool', `${event.toolName}: ${telemetryText}`);
    }
    this.callbacks.onToolEnd?.(event.toolName, joined, event.isError);
  }

  /** Handle agent_end error recovery and persistence. */
  private handleAgentEndEvent(messages: AgentMessage[]): void {
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === 'assistant' && (last as AssistantMessage).errorMessage) {
        const errorMsg = (last as AssistantMessage).errorMessage!;
        if (!this.isRecovering && isImageProcessingError(errorMsg)) {
          this.recoverFromImageError(messages);
          return;
        }
        if (!this.isRecovering && isContextOverflow(last as PiAssistantMessage)) {
          this.recoverFromOverflow(messages);
          return;
        }
        if (!this.isRecovering && this.isProcessing && !this.didStreamDeltas) {
          this.promptStreamErrorMessage = errorMsg;
          return;
        }
        this.isRecovering = false;
        emitAgentError('llm', errorMsg);
        this.callbacks.onError(errorMsg);
      } else {
        this.isRecovering = false;
      }
    }

    const persistMessages = this.agent?.state?.messages ?? messages;
    if (this.sessionStore && persistMessages.length > 0) {
      this.sessionStore
        .save({
          id: this.sessionId,
          messages: persistMessages,
          config: {},
          createdAt: this.sessionCreatedAt || Date.now(),
          updatedAt: Date.now(),
        })
        .catch((err) => {
          log.error('Failed to save agent session', {
            folder: this.scoop.folder,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  private handleAgentEvent(event: CoreAgentEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'message_update': {
        const ame = event.assistantMessageEvent as AssistantMessageEvent;
        if (ame.type === 'text_delta') {
          this.didStreamDeltas = true;
          this.callbacks.onResponse(ame.delta, true);
        }
        break;
      }

      case 'tool_execution_start': {
        this.callbacks.onToolStart?.(event.toolName, event.args);
        break;
      }

      case 'tool_execution_update': {
        this.handleToolUIEvents(event);
        break;
      }

      case 'tool_execution_end': {
        this.formatToolResult(event);
        break;
      }

      case 'message_end': {
        if (event.message.role === 'assistant') {
          const msg = event.message as AssistantMessage;
          const fullText = msg.content
            .filter((c): c is TextContent => c.type === 'text')
            .map((c) => c.text)
            .join('');

          if (fullText && !this.didStreamDeltas) {
            this.callbacks.onResponse(fullText, false);
          }
        }
        break;
      }

      case 'turn_end': {
        this.callbacks.onResponseDone();
        break;
      }

      case 'agent_end': {
        this.handleAgentEndEvent(event.messages);
        break;
      }
    }
  }

  /** Trim oversized messages for overflow recovery. Returns trimmed messages + count. */
  private trimOversizedMessages(messages: AgentMessage[]): {
    trimmed: AgentMessage[];
    replaced: number;
  } {
    const trimmed = messages.slice(0, -1);
    const TOKEN_THRESHOLD = 10000;
    const CHAR_THRESHOLD = TOKEN_THRESHOLD * 4;
    let replaced = 0;

    for (let i = trimmed.length - 1; i >= 0 && replaced < 5; i--) {
      const msg = trimmed[i] as RecoveryMessage;
      if (!Array.isArray(msg.content)) continue;

      let msgSize = 0;
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) msgSize += block.text.length;
        if (block.type === 'image' && block.data) msgSize += block.data.length;
      }

      if (msgSize > CHAR_THRESHOLD) {
        const role = msg.role === 'toolResult' ? 'tool result' : msg.role;
        const placeholder = {
          type: 'text' as const,
          text: `[Content removed: ${role} was too large for context window (${Math.round(msgSize / 1000)}K chars). The operation completed but output could not be retained.]`,
        };

        if (msg.role === 'assistant') {
          const toolCalls = msg.content.filter((block) => block.type === 'toolCall');
          trimmed[i] = {
            ...msg,
            content: [placeholder, ...toolCalls],
          } as AgentMessage;
        } else {
          trimmed[i] = {
            ...msg,
            content: [placeholder],
          } as AgentMessage;
        }
        replaced++;
        log.info('Replaced oversized message', {
          index: i,
          role: msg.role,
          size: msgSize,
          preservedToolCalls:
            msg.role === 'assistant' ? msg.content.filter((b) => b.type === 'toolCall').length : 0,
        });
      }
    }

    return { trimmed, replaced };
  }

  /**
   * Recover from a context overflow error by trimming oversized messages
   * and re-prompting the agent with an explanation.
   */
  private recoverFromOverflow(messages: AgentMessage[]): void {
    if (!this.agent) return;

    log.warn('Context overflow detected, attempting recovery', {
      folder: this.scoop.folder,
      messageCount: messages.length,
    });

    this.isRecovering = 'overflow';
    this.callbacks.onResponse(
      'Context window exceeded — recovering by trimming oversized messages...',
      false
    );

    try {
      const { trimmed, replaced } = this.trimOversizedMessages(messages);
      this.agent.state.messages = trimmed;

      const explanation =
        replaced > 0
          ? `[System: Context overflow recovered. ${replaced} oversized message(s) were replaced with placeholders to fit within the context window. The conversation continues — you may need to re-read files or re-run commands if their output was removed.]`
          : `[System: Context overflow recovered. Older messages were trimmed. The conversation continues — compaction will summarize history on the next turn.]`;

      this.agent.prompt(explanation).catch((err) => {
        log.error('Recovery re-prompt failed', {
          folder: this.scoop.folder,
          error: err instanceof Error ? err.message : String(err),
        });
        this.isRecovering = false;
        this.callbacks.onError(
          `Context overflow recovery failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    } catch (err) {
      log.error('Recovery failed', {
        folder: this.scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      this.isRecovering = false;
      this.callbacks.onError(
        `Context overflow recovery failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Recover from an image processing error by stripping ImageContent blocks
   * from recent messages and re-prompting the agent.
   */
  private recoverFromImageError(messages: AgentMessage[]): void {
    if (!this.agent) return;

    log.warn('Image processing error detected, attempting recovery', {
      folder: this.scoop.folder,
      messageCount: messages.length,
    });

    this.isRecovering = 'image';

    this.callbacks.onResponse(
      'Image rejected by API — removing problematic images and continuing...',
      false
    );

    try {
      // Remove the error assistant message (last)
      const trimmed = messages.slice(0, -1);

      // Walk backward through last 10 messages, strip all ImageContent blocks
      let stripped = 0;
      const limit = Math.max(0, trimmed.length - 10);

      for (let i = trimmed.length - 1; i >= limit; i--) {
        const msg = trimmed[i] as RecoveryMessage;
        if (!Array.isArray(msg.content)) continue;

        const hasImages = msg.content.some((block) => block.type === 'image');
        if (!hasImages) continue;

        // Remove image blocks, keep text blocks
        const filtered = msg.content.filter((block) => block.type !== 'image');

        if (filtered.length === 0) {
          // All content was images — replace with placeholder
          trimmed[i] = {
            ...msg,
            content: [{ type: 'text' as const, text: '[Image removed: rejected by API]' }],
          } as AgentMessage;
        } else {
          trimmed[i] = { ...msg, content: filtered } as AgentMessage;
        }
        stripped++;
      }

      this.agent.state.messages = trimmed;

      const explanation = `[System: An image was rejected by the API and has been removed from the conversation (${stripped} message(s) affected). The conversation continues without the image.]`;

      this.agent.prompt(explanation).catch((err) => {
        log.error('Image recovery re-prompt failed', {
          folder: this.scoop.folder,
          error: err instanceof Error ? err.message : String(err),
        });
        this.isRecovering = false;
        this.callbacks.onError(
          `Image error recovery failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    } catch (err) {
      log.error('Image recovery failed', {
        folder: this.scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      this.isRecovering = false;
      this.callbacks.onError(
        `Image error recovery failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async ensureDirectoryStructure(): Promise<void> {
    if (!this.fs) return;

    const dirs = this.scoop.isCone
      ? ['/workspace', '/shared', '/scoops', '/home', '/tmp', '/mnt']
      : [
          `/scoops/${this.scoop.folder}`,
          `/scoops/${this.scoop.folder}/workspace`,
          `/scoops/${this.scoop.folder}/home`,
          `/scoops/${this.scoop.folder}/tmp`,
          '/shared',
        ];

    for (const dir of dirs) {
      try {
        await this.fs.mkdir(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }
    }

    // Create default CLAUDE.md if missing. Best-effort: scoops with
    // pure-replace `writablePaths: []` (or no overlap with the memory
    // path) have no writable location for this file, and that's a
    // legitimate configuration — a read-only / audit-style scoop
    // simply runs without a persisted memory file. Swallowing the
    // EACCES keeps init on the happy path for zero-write sandboxes.
    const memoryPath = this.scoop.isCone
      ? '/workspace/CLAUDE.md'
      : `/scoops/${this.scoop.folder}/CLAUDE.md`;
    try {
      await this.fs.readFile(memoryPath);
    } catch {
      const defaultMemory = `# ${this.scoop.assistantLabel} Memory

${this.scoop.isCone ? 'Role: Cone (main orchestrator)' : `Scoop: ${this.scoop.name}`}
Folder: ${this.scoop.folder}
Created: ${new Date().toISOString()}

## Preferences
(Add preferences here)

## Context
(Add important context here)
`;
      try {
        await this.fs.writeFile(memoryPath, defaultMemory);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'EACCES') {
          log.debug('Skipping default memory write (sandbox is read-only)', {
            folder: this.scoop.folder,
            path: memoryPath,
          });
        } else {
          throw err;
        }
      }
    }
  }

  private buildSystemPrompt(
    globalMemory: string,
    scoopMemory: string,
    skills: import('./skills.js').Skill[]
  ): string {
    const assistantName = this.scoop.config?.assistantName || this.scoop.assistantLabel;

    const basePrompt = `# ${assistantName}

You are ${assistantName}, ${this.scoop.isCone ? 'the main assistant (cone)' : 'a scoop assistant'} in SLICC (Self-Licking Ice Cream Cone).

## Your Capabilities

You have access to:
- A virtual filesystem at ${this.scoop.isCone ? '/workspace' : `/scoops/${this.scoop.folder}/workspace`} (your working directory)
- A bash shell for running commands (via the bash tool)
- File reading, writing, and editing tools
- Use shell commands like \`rg\`, \`grep\`, and \`find\` through the bash tool for search
${this.scoop.isCone ? '' : '- **send_message**: Send messages immediately while working (for progress updates)\n'}- **schedule_task**: Schedule recurring or one-time tasks
- **list_tasks**, **pause_task**, **resume_task**, **cancel_task**: Manage scheduled tasks

${
  this.scoop.isCone
    ? `
As the cone (main assistant), you have elevated privileges:
- **list_scoops**: See all registered scoops
- **register_scoop**: Add new scoops
- **update_global_memory**: Update the global CLAUDE.md shared across all scoops
- Full filesystem access (unrestricted)
- You can schedule tasks for any scoop

## Delegating to Scoops

Use the **delegate_to_scoop** tool to send work to scoops. IMPORTANT:
- The scoop has NO access to your conversation history
- You MUST write a **complete, self-contained prompt** with ALL context, instructions, file paths, URLs, etc.
- If the user says "do the same" or references earlier work, YOU must expand that into explicit instructions
- Use **list_scoops** first to see available scoop names

**You will automatically receive a notification when a scoop finishes.** The notification includes a VFS path to the full output, the total line count, and the first 1000 characters.
You do NOT need to schedule polling tasks or check for completion markers — just delegate and wait. You will be
prompted again when they are done, and you can decide whether to inspect the saved file before acting on the result.
`
    : `
You are a scoop with restricted filesystem access:
- Your workspace: /scoops/${this.scoop.folder}/
- Shared directory: /shared/ (read-write for all scoops)
- Stay focused on your assigned tasks.
`
}

## Memory

Your memory is organized hierarchically:
- **Global memory** (/shared/CLAUDE.md): Read by all scoops, ${this.scoop.isCone ? 'use update_global_memory tool to modify it' : 'read-only for you'}
- **${this.scoop.isCone ? 'Cone' : 'Scoop'} memory** (${this.scoop.isCone ? '/workspace/CLAUDE.md' : `/scoops/${this.scoop.folder}/CLAUDE.md`}): Your private memory

When you learn something important:
- Use your memory for context-specific notes (edit with write_file or edit_file)
${this.scoop.isCone ? '- Use update_global_memory tool for information that should be shared across all scoops' : ''}

${
  this.scoop.isCone
    ? ''
    : `## Communication

When using send_message:
- Use it for progress updates on long tasks
- Use it when you want to send multiple messages
- Your final output is also sent, so don't repeat yourself
`
}${
  this.scoop.config?.structuredOutputSchema
    ? '\n\nIMPORTANT: your final action MUST be a single call to the StructuredOutput tool; its arguments are your return value and must satisfy the schema. Do not answer in prose.'
    : ''
}
${this.scoop.config?.systemPromptAppend ?? ''}`;

    // Build the full prompt with memories and skills
    let fullPrompt = basePrompt;

    // Add global memory first (shared context)
    if (globalMemory) {
      fullPrompt += `

---
GLOBAL MEMORY (shared across all scoops):
${globalMemory}
---`;
    }

    // Add scoop memory
    if (scoopMemory) {
      fullPrompt += `

---
${this.scoop.isCone ? 'CONE' : 'SCOOP'} MEMORY (${this.scoop.name}):
${scoopMemory}
---`;
    }

    // Add skills
    const skillsSection = formatSkillsForPrompt(skills);
    if (skillsSection) {
      fullPrompt += skillsSection;
    }

    return fullPrompt;
  }
}
