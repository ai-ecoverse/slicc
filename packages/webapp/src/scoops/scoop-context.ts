/**
 * Scoop Context — the facade over one work unit's runtime.
 *
 * Each unit (cone or scoop) gets a filesystem view, a shell, an `Agent`, a
 * session history, skills, and tools. THIS file owns only the coordination:
 * it holds the `agent` / `fs` / `shell` handles, wires the collaborators in
 * `scoop-context/`, and sequences init → prompt → dispose.
 *
 * Everything that changes for its own reason lives next door (#2334); each
 * module's header says what it owns and why it changes:
 *
 * - `scoop-context/runtime-init.ts` — the one-time boot sequence
 * - `scoop-context/turn-runner.ts` — attempt/retry policy
 * - `scoop-context/turn-process.ts` — the turn's kernel pid + exit code
 * - `scoop-context/run-bounds.ts` — per-run turn + wall-clock ceilings (#1972)
 * - `scoop-context/agent-event-router.ts` — agent events → UI callbacks
 * - `scoop-context/agent-end-dispatch.ts` — what a terminal `agent_end` means
 * - `scoop-context/overflow-recovery.ts` — context-overflow compaction ladder
 * - `scoop-context/image-recovery.ts` — rejected-image recovery
 * - `scoop-context/session-persistence.ts` — durable history (#1987)
 * - `scoop-context/bash-job-reaper.ts` — detached job pids (#1166)
 * - `scoop-context/live-updates.ts` — hot-swaps onto a running agent
 * - `scoop-context/shell-and-skills.ts`, `tools.ts`, `agent-factory.ts`,
 *   `session-helpers.ts`, `system-prompt.ts`, `directory-structure.ts`,
 *   `memories.ts`, `sudo-wiring.ts` — assembly, one stage each
 * - `scoop-context/model-resolution.ts`, `thinking-level.ts`, `shell-env.ts`,
 *   `error-classification.ts` — record-level questions, no agent required
 * - `scoop-context/callbacks.ts` — the owner's contract with a unit
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { createCompactContext } from '../core/context-compaction.js';
import type {
  Agent,
  AgentMessage,
  AssistantMessage,
  AgentEvent as CoreAgentEvent,
  ImageContent,
  TextContent,
} from '../core/index.js';
import { createLogger } from '../core/index.js';
import type { SessionStore } from '../core/session.js';
import type { VirtualFS } from '../fs/index.js';
import type { RestrictedFS } from '../fs/restricted-fs.js';
import type { Process, ProcessManager, ProcessOwner } from '../kernel/process-manager.js';
import type { AlmostBashShellHeadless } from '../shell/almost-bash-shell-headless.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import type { TurnGuestGate } from '../sudo/types.js';
import { conversationKeyFor, workspaceIdFor } from '../work-unit/conversation/key.js';
import type { WorkUnitConversationStore } from '../work-unit/conversation/store.js';
import { tmpDirFor, toDescriptor } from '../work-unit/descriptor.js';
import { rootsOf } from '../work-unit/policy.js';
import { chatSessionIdFor, processOwnerKindFor } from '../work-unit/record.js';
import type { WorkUnitDescriptor } from '../work-unit/types.js';
import { handleAgentEnd } from './scoop-context/agent-end-dispatch.js';
import { type AgentEventSink, routeAgentEvent } from './scoop-context/agent-event-router.js';
import { BashJobReaper } from './scoop-context/bash-job-reaper.js';
import type { ScoopContextCallbacks } from './scoop-context/callbacks.js';
import { ImageRecovery } from './scoop-context/image-recovery.js';
import {
  applyModelUpdate,
  applyThinkingLevel,
  rebuildSystemPrompt,
} from './scoop-context/live-updates.js';
import { estimateContextFill, missingApiKeyMessage } from './scoop-context/model-resolution.js';
import { OverflowRecovery } from './scoop-context/overflow-recovery.js';
import { RunBounds } from './scoop-context/run-bounds.js';
import { buildScoopRuntime } from './scoop-context/runtime-init.js';
import { SessionPersistence } from './scoop-context/session-persistence.js';
import { ownLickTargetFor } from './scoop-context/shell-env.js';
import { getLockedEffortLevel } from './scoop-context/thinking-level.js';
import {
  finishTurnProcess,
  signalTurnProcess,
  spawnTurnProcess,
} from './scoop-context/turn-process.js';
import { queuePromptIfBusy, TurnRunner } from './scoop-context/turn-runner.js';
import type { RegisteredScoop } from './types.js';

const log = createLogger('scoop-context');

export type { ScoopContextCallbacks } from './scoop-context/callbacks.js';
export {
  abortableSleep,
  isImageProcessingError,
  isNonRetryableError,
  isRetryableError,
} from './scoop-context/error-classification.js';
export { buildScoopShellEnv, ownLickTargetFor } from './scoop-context/shell-env.js';
export { resolveThinkingLevel } from './scoop-context/thinking-level.js';

export class ScoopContext {
  private scoop: RegisteredScoop;
  private callbacks: ScoopContextCallbacks;
  private fs: VirtualFS | RestrictedFS | null = null;
  private shell: AlmostBashShellHeadless | null = null;
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
   * Process manager. When set, each turn becomes a `kind:'scoop-turn'` pid —
   * see `scoop-context/turn-process.ts` for the spawn/signal/exit contract.
   * Optional: tests construct `ScoopContext` without one and the inline
   * orchestrator path stays untouched; kernel-worker boot wires it through
   * `createKernelHost`.
   */
  private processManager: ProcessManager | null = null;
  private currentTurnProcess: Process | null = null;

  private compactFn: ReturnType<typeof createCompactContext> | null = null;
  private getCompactionApiKey: (() => string | undefined) | null = null;
  private coneJid: string | undefined;
  /**
   * Policy / workspace / completion view of this unit, derived once from the
   * record's ownership edge (#1666). Every former `isCone` branch in this
   * class reads a field of this descriptor instead.
   */
  private readonly unit: WorkUnitDescriptor;
  /** Process-owner label for the kernel process table. */
  private readonly owner: ProcessOwner;

  private skillsFs: VirtualFS | null = null;
  private sudoManager: SudoManager | null = null;

  private structuredOutputValue: unknown;
  /** Raw API effort override (e.g. `'max'`) bypassing pi-ai's ThinkingLevel. */
  private activeEffortOverride: string | undefined;
  private structuredOutputCaptured = false;

  /** Collaborators — see the module header for what each one owns. */
  private readonly sessions: SessionPersistence;
  private readonly runBounds: RunBounds;
  private readonly bashJobs: BashJobReaper;
  private readonly imageRecovery: ImageRecovery;
  private readonly overflow: OverflowRecovery;
  private readonly turnRunner: TurnRunner;

  /**
   * Translation of agent events into this context's state and the owner's
   * callbacks. Arrow properties, so the field initializer may reference
   * collaborators the constructor body assigns.
   */
  private readonly eventSink: AgentEventSink = {
    textDelta: (delta) => {
      this.didStreamDeltas = true;
      this.callbacks.onResponse(delta, true);
    },
    toolStart: (toolName, args, toolCallId) =>
      this.callbacks.onToolStart?.(toolName, args, toolCallId),
    toolUI: (toolName, requestId, html) => this.callbacks.onToolUI?.(toolName, requestId, html),
    toolUIDone: (requestId) => this.callbacks.onToolUIDone?.(requestId),
    toolProgress: (toolName, progress, toolCallId) =>
      this.callbacks.onToolProgress?.(toolName, progress, toolCallId),
    toolResult: (toolName, text, isError, toolCallId) =>
      this.callbacks.onToolEnd?.(toolName, text, isError, toolCallId),
    checkpoint: () => this.sessions.schedule(),
    assistantMessageEnd: (message) => this.handleAssistantMessageEnd(message),
    turnStart: () => this.runBounds.enforceOnTurnStart(),
    turnCompleted: () => this.runBounds.recordCompletedTurn(),
    responseDone: () => this.callbacks.onResponseDone(),
    agentEnd: (messages, abortSignal) => this.handleAgentEndEvent(messages, abortSignal),
  };

  constructor(
    scoop: RegisteredScoop,
    callbacks: ScoopContextCallbacks,
    fs: VirtualFS | RestrictedFS,
    sessionStore?: SessionStore,
    skillsFs?: VirtualFS,
    coneJid?: string,
    processManager?: ProcessManager,
    sudoManager?: SudoManager | null,
    conversationStore?: WorkUnitConversationStore | null
  ) {
    this.scoop = scoop;
    this.unit = toDescriptor(scoop);
    this.owner = { kind: processOwnerKindFor(scoop), scoopJid: scoop.jid };
    this.callbacks = callbacks;
    this.fs = fs;
    this.skillsFs = skillsFs ?? null;
    this.coneJid = coneJid;
    this.processManager = processManager ?? null;
    this.sudoManager = sudoManager ?? null;

    this.sessions = new SessionPersistence({
      store: sessionStore ?? null,
      // The canonical conversation record (#2275). Absent — no store wired,
      // or a float that persists nothing — leaves the legacy `agent-sessions`
      // path exactly as it was.
      canonical: conversationStore
        ? {
            store: conversationStore,
            identity: {
              key: conversationKeyFor(scoop),
              workUnitId: scoop.jid,
              workspaceId: workspaceIdFor(scoop),
              folder: scoop.folder,
              legacyKeys: {
                agentSessionId: scoop.jid,
                chatSessionId: chatSessionIdFor(scoop),
              },
            },
          }
        : null,
      // Internal persistence key — stable across days/restarts so saved
      // conversations can be restored by `SessionStore.load`. The outgoing
      // Adobe `X-Session-Id` is computed separately in `init()`.
      sessionId: scoop.jid,
      folder: scoop.folder,
      getMessages: () => this.agent?.state?.messages,
      isDisposed: () => this.disposed,
      onRestoreError: (message) => this.callbacks.onError(message),
    });
    this.runBounds = new RunBounds({
      getConfig: () => this.scoop.config,
      isDisposed: () => this.disposed,
      onTripped: () => {
        this.setStatus('error');
        this.stop();
      },
    });
    this.bashJobs = new BashJobReaper({
      processManager: this.processManager,
      cwd: this.unit.workspace.root,
      owner: this.owner,
      getTurnPid: () => this.currentTurnProcess?.pid,
      folder: scoop.folder,
    });
    this.imageRecovery = new ImageRecovery({
      getAgent: () => this.agent,
      onResponse: (text, isPartial) => this.callbacks.onResponse(text, isPartial),
      onError: (message) => this.callbacks.onError(message),
      folder: scoop.folder,
    });
    this.overflow = new OverflowRecovery({
      getAgent: () => this.agent,
      isDisposed: () => this.disposed,
      getTurnSignal: () => this.promptAbortController?.signal,
      getCompactFn: () => this.compactFn,
      getCompactionApiKey: () => this.getCompactionApiKey?.(),
      isImageRecoveryActive: () => this.imageRecovery.isActive,
      onResponse: (text, isPartial) => this.callbacks.onResponse(text, isPartial),
      onExhausted: (message) => this.reportExhaustedOverflow(message),
      setStatus: (status) => this.setStatus(status),
      scoopName: scoop.name,
      folder: scoop.folder,
    });
    this.turnRunner = new TurnRunner({
      isDisposed: () => this.disposed,
      overflow: this.overflow,
      beginAttempt: () => {
        this.didStreamDeltas = false;
        this.promptStreamErrorMessage = null;
      },
      getStreamError: () => this.promptStreamErrorMessage,
      setStatus: (status) => this.setStatus(status),
      onError: (message) => this.callbacks.onError(message),
      onFatalError: callbacks.onFatalError
        ? (message) => this.callbacks.onFatalError?.(message)
        : undefined,
      isInteractive: this.unit.completion.mode === 'interactive',
      scoopName: scoop.name,
      folder: scoop.folder,
    });
  }

  /**
   * `ownLickTargetFor` against the live roster, so the answer follows roots
   * being created and dropped instead of a folder name captured at boot.
   */
  private ownLickTarget(): string | undefined {
    return ownLickTargetFor(this.unit, this.scoop, rootsOf(this.callbacks.getScoops())[0]?.jid);
  }

  /**
   * This unit's `$TMPDIR`, resolved against the LIVE roster for the same
   * reason {@link ownLickTarget} is: a scoop's scratch nests under the cone
   * that owns it, and that edge is a roster lookup, not a field on the
   * record.
   */
  private ownTmpDir(): string {
    return tmpDirFor(this.callbacks.getScoops(), this.scoop);
  }

  getStructuredOutput() {
    return { captured: this.structuredOutputCaptured, value: this.structuredOutputValue };
  }

  /** Whether a prompt is active or the underlying agent is still streaming. */
  get isBusy(): boolean {
    return this.isProcessing || (this.agent?.state?.isStreaming ?? false);
  }

  /** Initialize the scoop's environment */
  async init(): Promise<void> {
    this.setStatus('initializing');

    try {
      if (!this.fs) throw new Error('Filesystem not provided');

      const runtime = await buildScoopRuntime({
        scoop: this.scoop,
        unit: this.unit,
        fs: this.fs,
        skillsFs: this.skillsFs,
        callbacks: this.callbacks,
        sessions: this.sessions,
        sudoManager: this.sudoManager,
        processManager: this.processManager,
        processOwner: this.owner,
        coneJid: this.coneJid,
        getTurnPid: () => this.currentTurnProcess?.pid,
        getTurnGuestGates: () => this.turnGuestGates,
        getLickTarget: () => this.ownLickTarget(),
        getTmpDir: () => this.ownTmpDir(),
        getEffortOverride: () => this.activeEffortOverride,
        isDisposed: () => this.disposed,
        onShellReady: (shell) => {
          this.shell = shell;
        },
        onStructuredOutput: (value) => {
          this.structuredOutputValue = value;
          this.structuredOutputCaptured = true;
        },
        spawnBashJob: (command) => this.bashJobs.spawn(command),
      });

      if (runtime.kind === 'abandoned') return;
      if (runtime.kind === 'deferred') {
        this.setStatus('ready');
        return;
      }

      this.compactFn = runtime.compactFn;
      this.getCompactionApiKey = runtime.getCompactionApiKey;
      this.activeEffortOverride = runtime.effortOverride;
      this.agent = runtime.agent;
      this.unsubscribe = this.agent.subscribe((event, signal) =>
        this.handleAgentEvent(event, signal)
      );

      this.setStatus('ready');
      log.info('ScoopContext initialized', {
        folder: this.scoop.folder,
        toolCount: runtime.toolCount,
      });
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
    if (this.agent) return true;

    this.callbacks.onError(missingApiKeyMessage(this.scoop));
    return false;
  }

  /** Clean up turn process and state. */
  private cleanupPromptState(
    abortController: AbortController,
    turnProcess: Process | null,
    lastError: Error | null,
    abortSignal: AbortSignal
  ): void {
    // Deliberately NOT clearing `turnGuestGates` here. The agent can begin a
    // follow-up turn internally without re-entering `prompt()`, and that turn is
    // still downstream of the guest's message; clearing here let it run
    // ungated. The set is replaced when the next turn genuinely starts, so the
    // worst case is over-gating the owner inside one busy window — the safe
    // direction to be wrong in.
    this.runBounds.disarm();
    // A bound-terminated run must not read as a clean completion: surface
    // the ceiling through onError so observers (the agent bridge) report a
    // non-zero exit instead of a truncated-but-"successful" result (#1972).
    const boundNote = this.runBounds.takeExceededNote();
    if (boundNote !== null) {
      this.callbacks.onError(`agent run terminated: ${boundNote}`);
    }
    // Flush-on-abort (#1987): a turn that ends in an error or an abort may
    // never reach `agent_end`, so persist whatever completed messages the
    // agent accumulated before the failure — the debounced checkpoint alone
    // could still be pending.
    if (lastError || abortSignal.aborted) {
      this.sessions.persistNow();
    }
    this.isProcessing = false;
    if (!this.disposed && this.status === 'processing') {
      this.setStatus('ready');
    }
    if (this.promptAbortController === abortController) {
      this.promptAbortController = null;
    }
    finishTurnProcess(this.processManager, turnProcess, {
      lastError,
      aborted: abortSignal.aborted,
    });
    if (this.currentTurnProcess === turnProcess) {
      this.currentTurnProcess = null;
    }
  }

  /**
   * Send a prompt to this scoop's agent. If already processing, queues it —
   * via `steer()` when `options.steer` is set (interrupt the running turn),
   * otherwise via `followUp()`.
   */
  /**
   * Every guest gate that applies to the turn currently running.
   *
   * A SET, not one gate: a router batch can merge messages from several seats
   * into one prompt, and honouring only the first would submit the others'
   * actions to an approver they never named. A tool call must clear ALL of
   * them.
   *
   * Lifetime is deliberately conservative. The set is replaced only when a turn
   * genuinely BEGINS (`queuePromptIfBusy` declined to queue); a prompt that
   * queues instead ADDS to it, because the running turn will consume that
   * content. It is not cleared when a turn ends: the agent can start a
   * follow-up turn internally without re-entering `prompt()`, and that turn is
   * still downstream of the guest's message. An owner's next explicit prompt
   * resets it to empty, which is the only transition that may un-gate.
   *
   * Read LIVE by the tool adapter rather than captured at tool-build time —
   * tools are built once per scoop while turns come and go.
   */
  private turnGuestGates: TurnGuestGate[] = [];

  async prompt(
    text: string,
    images: ImageContent[] = [],
    options?: { steer?: boolean; guestGates?: TurnGuestGate[] }
  ): Promise<void> {
    if (!(await this.ensureAgentReady())) return;
    const incoming = options?.guestGates ?? [];
    if (
      queuePromptIfBusy(this.agent!, text, images, {
        steer: options?.steer ?? false,
        isProcessing: this.isProcessing,
        folder: this.scoop.folder,
      })
    ) {
      // Queued INTO the running turn, so its gates join that turn's set. Never
      // replaces: an owner message arriving mid-guest-turn used to reset this
      // to empty and un-gate the guest's remaining tool calls.
      for (const gate of incoming) this.addTurnGuestGate(gate);
      return;
    }
    // A turn is genuinely starting: this prompt's gates ARE the turn's gates.
    // The only transition that may un-gate.
    this.turnGuestGates = [...incoming];

    const agent = this.agent!;

    this.promptAbortController?.abort();
    const abortController = new AbortController();
    this.promptAbortController = abortController;
    const abortSignal = abortController.signal;

    this.isProcessing = true;
    this.setStatus('processing');
    this.overflow.resetForRun();

    const turnProcess = spawnTurnProcess(this.processManager, {
      text,
      cwd: this.unit.workspace.root,
      owner: this.owner,
      abortController,
    });
    this.currentTurnProcess = turnProcess;
    this.runBounds.arm();

    // Hoisted so the `finally` can thread it into cleanupPromptState, which uses
    // it to set the turn process exit code (1 on failure, 0 on clean completion).
    let lastError: Error | null = null;
    try {
      lastError = await this.turnRunner.run(agent, text, images, abortSignal);

      if (lastError && !this.disposed && !abortSignal.aborted) {
        this.turnRunner.reportExhausted(lastError);
        return;
      }

      // Only set 'ready' if status hasn't been changed to 'error' by a fatal handler.
      // The turn runner sets 'error' before returning, so we preserve that.
      if (!this.disposed && !abortSignal.aborted && this.status !== 'error') {
        this.setStatus('ready');
      }
    } finally {
      this.cleanupPromptState(abortController, turnProcess, lastError, abortSignal);
    }
  }

  /**
   * Add one gate to the running turn, ignoring an exact duplicate so a chatty
   * seat cannot make every tool call prompt N times.
   */
  private addTurnGuestGate(gate: TurnGuestGate): void {
    const key = JSON.stringify(gate);
    if (this.turnGuestGates.some((existing) => JSON.stringify(existing) === key)) return;
    this.turnGuestGates.push(gate);
  }

  /** Stop the current agent operation and clear any queued prompts */
  stop(): void {
    signalTurnProcess(
      this.processManager,
      this.currentTurnProcess,
      'SIGINT',
      this.promptAbortController
    );
    this.agent?.clearAllQueues?.();
    this.agent?.abort?.();
    this.isProcessing = false;
    // Preserve an `error` state (a tripped bound set it deliberately, so the
    // lifecycle doesn't announce completion); a plain user interrupt lands
    // on `ready` as before.
    if (this.status !== 'error') this.setStatus('ready');
  }

  /** Clear the agent's in-memory conversation history (used by clear-chat). */
  clearMessages(): void {
    if (this.agent) {
      this.agent.state.messages = [];
    }
  }

  /**
   * Clear the live messages AND every durable representation of this unit's
   * conversation (#2275) — the canonical record and the legacy agent
   * session. `clearMessages()` alone only empties the in-memory list, which
   * a reload would refill from whichever store still held it.
   */
  async clearSession(): Promise<void> {
    this.clearMessages();
    await this.sessions.clear();
  }

  /** Get the agent's current in-memory messages (for diagnostics). */
  getAgentMessages(): AgentMessage[] {
    return this.agent?.state?.messages ? structuredClone(this.agent.state.messages) : [];
  }

  /**
   * 0..1 estimate of how full the model's context window is, from the LAST
   * assistant turn's reported usage. 0 before the first turn.
   */
  getContextFill(): number {
    return estimateContextFill(this.agent?.state?.messages ?? [], this.scoop);
  }

  /** Get the session ID used for agent-sessions DB persistence. */
  getSessionId(): string {
    return this.sessions.sessionId;
  }

  /** Get the scoop's filesystem */
  getFS(): VirtualFS | RestrictedFS | null {
    return this.fs;
  }

  /** Get the scoop's shell */
  getShell(): AlmostBashShellHeadless | null {
    return this.shell;
  }

  /**
   * Re-resolve this unit's model + thinking level from its own record and
   * apply them to the running agent (#2310).
   */
  updateModel(): void {
    if (!this.agent) return;
    this.activeEffortOverride = applyModelUpdate(this.agent, this.scoop);
  }

  /** Hot-reload skills from VFS and update the agent's system prompt. */
  async reloadSkills(): Promise<void> {
    if (!this.agent) return;
    await rebuildSystemPrompt(this.agent, {
      scoop: this.scoop,
      unit: this.unit,
      fs: this.fs!,
      skillsFs: this.skillsFs,
      getGlobalMemory: () => this.callbacks.getGlobalMemory(),
    });
  }

  /**
   * Update the active reasoning/thinking level for this scoop, returning the
   * level actually applied. The caller persists `scoop.thinking` separately if
   * the change should survive a reload — `ScoopLifecycleManager` handles that.
   */
  setThinkingLevel(level: ThinkingLevel | undefined, effortOverride?: string): ThinkingLevel {
    if (!this.agent) return 'off';
    if (getLockedEffortLevel()) return this.agent.state.thinkingLevel;
    this.activeEffortOverride = effortOverride;
    return applyThinkingLevel(this.agent, level);
  }

  /** Currently applied thinking level on the running agent. */
  getThinkingLevel(): ThinkingLevel {
    return this.agent?.state.thinkingLevel ?? 'off';
  }

  /** Cleanup */
  dispose(): void {
    // Final checkpoint BEFORE the disposed flag blocks writes and the agent
    // reference is dropped — dispose mid-turn must not lose completed
    // messages a pending debounce hadn't flushed yet (#1987).
    this.sessions.persistNow();
    this.disposed = true;
    // Clear the run-bound wall-clock timer symmetrically with
    // `cleanupPromptState` (#1972): a dispose mid-bounded-run (shutdown,
    // drop_scoop) bypasses cleanup, and the armed timer would otherwise
    // hold a reference to this disposed context until it fires.
    this.runBounds.disarm();
    // Cancel any in-flight retry loop / backoff sleep before tearing down the
    // agent. SIGTERM matches the conventional shutdown semantic — the turn
    // loop's `finally` runs `pm.exit(pid, null)` and the manager derives the
    // 143 exit code from terminatedBy.
    signalTurnProcess(
      this.processManager,
      this.currentTurnProcess,
      'SIGTERM',
      this.promptAbortController
    );
    this.bashJobs.reapAll();
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
    this.compactFn = null;
    this.getCompactionApiKey = null;
    this.agent = null;
    this.shell = null;
    this.fs = null;
  }

  /** The agent subscription: drop events after dispose, else route them. */
  private handleAgentEvent(event: CoreAgentEvent, abortSignal?: AbortSignal): void {
    if (this.disposed) return;
    routeAgentEvent(event, this.eventSink, abortSignal);
  }

  private setStatus(status: 'initializing' | 'ready' | 'processing' | 'error'): void {
    if (this.disposed) return;
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  /** An assistant `message_end`: re-arm recovery and flush a non-streamed answer. */
  private handleAssistantMessageEnd(message: AssistantMessage): void {
    if (!message.errorMessage) this.overflow.markAssistantSucceeded();
    const fullText = message.content
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text)
      .join('');

    if (fullText && !this.didStreamDeltas) {
      this.callbacks.onResponse(fullText, false);
    }
  }

  /** Handle agent_end error recovery and persistence. */
  private handleAgentEndEvent(messages: AgentMessage[], abortSignal?: AbortSignal): void {
    if (this.disposed || abortSignal?.aborted) return;
    handleAgentEnd(
      messages,
      {
        imageRecovery: this.imageRecovery,
        overflow: this.overflow,
        isProcessing: () => this.isProcessing,
        didStreamDeltas: () => this.didStreamDeltas,
        latchStreamError: (message) => {
          this.promptStreamErrorMessage = message;
        },
        onError: (message) => this.callbacks.onError(message),
        persist: (fallback) => this.sessions.persistNow(fallback),
      },
      abortSignal
    );
  }

  /**
   * Overflow recovery has run out of rungs. An interactive unit gets the
   * message on the normal error channel; a delegated one must reach the cone
   * even through scoop_mute, so it goes out fatal when the owner wired one.
   */
  private reportExhaustedOverflow(message: string): void {
    if (this.unit.completion.mode === 'interactive') {
      this.callbacks.onError(message);
    } else if (this.callbacks.onFatalError) {
      this.callbacks.onFatalError(message);
    } else {
      this.callbacks.onError(message);
    }
  }
}
