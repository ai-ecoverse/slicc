import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { isGelatiereUnit } from '../base/gelatiere-constants.js';
import {
  type CompactionSnapshot,
  type CompactionTrigger,
  type createCompactContext,
  estimateConversationTokens,
} from '../core/context-compaction.js';
import { isFeatureEnabled } from '../core/feature-flags.js';
import type {
  Agent,
  AgentMessage,
  AssistantMessage,
  AgentEvent as CoreAgentEvent,
  ImageContent,
  TextContent,
  ToolResultMessage,
} from '../core/index.js';
import { createLogger } from '../core/index.js';
import type { SessionStore } from '../core/session.js';
import type { VirtualFS } from '../fs/index.js';
import type { RestrictedFS } from '../fs/restricted-fs.js';
import type { Process, ProcessManager, ProcessOwner } from '../kernel/process-manager.js';
import type { AlmostBashShellHeadless } from '../shell/almost-bash-shell-headless.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import type { TurnGuestGate } from '../sudo/types.js';
import type { CapabilityBroker } from '../work-unit/capability/index.js';
import { conversationIdentityFor } from '../work-unit/conversation/key.js';
import type { WorkUnitConversationStore } from '../work-unit/conversation/store.js';
import { tmpDirFor, toDescriptor } from '../work-unit/descriptor.js';
import { rootsOf } from '../work-unit/policy.js';
import { processOwnerKindFor } from '../work-unit/record.js';
import type { WorkUnitDescriptor } from '../work-unit/types.js';
import { handleAgentEnd } from './scoop-context/agent-end-dispatch.js';
import { type AgentEventSink, routeAgentEvent } from './scoop-context/agent-event-router.js';
import { BashJobReaper } from './scoop-context/bash-job-reaper.js';
import type { ScoopContextCallbacks } from './scoop-context/callbacks.js';
import type { IdleCompaction } from './scoop-context/idle-compaction.js';
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
import type { TurnJournal } from './scoop-context/turn-journal.js';
import {
  finishTurnProcess,
  signalTurnProcess,
  spawnTurnProcess,
} from './scoop-context/turn-process.js';
import { queuePromptIfBusy, TurnRunner } from './scoop-context/turn-runner.js';
import type { RegisteredScoop } from './types.js';

const log = createLogger('scoop-context');

export const TOOL_DURABILITY_WAIT_MS = 2_000;

export type { ScoopContextCallbacks } from './scoop-context/callbacks.js';
export {
  abortableSleep,
  isImageProcessingError,
  isNonRetryableError,
  isRetryableError,
} from './scoop-context/error-classification.js';
export { buildScoopShellEnv, ownLickTargetFor } from './scoop-context/shell-env.js';
export { resolveThinkingLevel } from './scoop-context/thinking-level.js';

export interface ClearSessionOptions {
  discardLiveSnapshot?: boolean;
}

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

  private promptAbortController: AbortController | null = null;

  private processManager: ProcessManager | null = null;
  private currentTurnProcess: Process | null = null;

  private compactFn: ReturnType<typeof createCompactContext> | null = null;
  private getCompactionApiKey: (() => string | undefined) | null = null;
  private coneJid: string | undefined;

  private readonly unit: WorkUnitDescriptor;

  private readonly owner: ProcessOwner;

  private skillsFs: VirtualFS | null = null;
  private sudoManager: SudoManager | null = null;
  private capabilityBroker: CapabilityBroker | null = null;

  private structuredOutputValue: unknown;

  private activeEffortOverride: string | undefined;
  private structuredOutputCaptured = false;

  private readonly sessions: SessionPersistence;
  private readonly runBounds: RunBounds;
  private readonly bashJobs: BashJobReaper;
  private readonly imageRecovery: ImageRecovery;
  private readonly overflow: OverflowRecovery;

  private idleCompaction: IdleCompaction | null = null;
  private idleCompactionLoading: Promise<IdleCompaction> | null = null;

  private sessionGeneration = 0;
  private readonly turnRunner: TurnRunner;

  private readonly turnJournal: TurnJournal | null;

  private readonly eventSink: AgentEventSink = {
    textDelta: (delta) => {
      this.didStreamDeltas = true;
      this.callbacks.onResponse(delta, true);
    },
    toolStart: (toolName, args, toolCallId) => {
      this.callbacks.onToolStart?.(toolName, args, toolCallId);
      return this.makeToolCallDurable(toolName, args, toolCallId);
    },
    toolUI: (toolName, requestId, html) => this.callbacks.onToolUI?.(toolName, requestId, html),
    toolUIDone: (requestId) => this.callbacks.onToolUIDone?.(requestId),
    toolProgress: (toolName, progress, toolCallId) =>
      this.callbacks.onToolProgress?.(toolName, progress, toolCallId),
    toolResult: (toolName, text, isError, toolCallId) =>
      this.callbacks.onToolEnd?.(toolName, text, isError, toolCallId),
    checkpoint: (message) => this.checkpoint(message),
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
    conversationStore?: WorkUnitConversationStore | null,
    capabilityBroker?: CapabilityBroker | null,
    turnJournal?: TurnJournal | null
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
    this.capabilityBroker = capabilityBroker ?? null;
    this.turnJournal = turnJournal ?? null;

    this.sessions = new SessionPersistence({
      store: sessionStore ?? null,

      canonical: conversationStore
        ? { store: conversationStore, identity: conversationIdentityFor(scoop) }
        : null,

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

  private ownLickTarget(): string | undefined {
    return ownLickTargetFor(this.unit, this.scoop, rootsOf(this.callbacks.getScoops())[0]?.jid);
  }

  private ownTmpDir(): string {
    return tmpDirFor(this.callbacks.getScoops(), this.scoop);
  }

  getStructuredOutput() {
    return { captured: this.structuredOutputCaptured, value: this.structuredOutputValue };
  }

  get isBusy(): boolean {
    return this.isProcessing || (this.agent?.state?.isStreaming ?? false);
  }

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
        capabilityBroker: this.capabilityBroker,
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

        onBeforeCompaction: (messages, trigger) =>
          this.maybeSnapshotBeforeCompaction(messages, trigger),
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

  private async ensureAgentReady(): Promise<boolean> {
    if (this.agent) return true;

    await this.init();
    if (this.agent) return true;

    this.callbacks.onError(missingApiKeyMessage(this.scoop));
    return false;
  }

  private cleanupPromptState(
    abortController: AbortController,
    turnProcess: Process | null,
    lastError: Error | null,
    abortSignal: AbortSignal
  ): void {
    this.runBounds.disarm();

    const boundNote = this.runBounds.takeExceededNote();
    if (boundNote !== null) {
      this.callbacks.onError(`agent run terminated: ${boundNote}`);
    }

    if (lastError || abortSignal.aborted) {
      this.sessions.persistNow();
    }
    this.isProcessing = false;

    this.turnJournal?.end(this.scoop.jid);
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
      for (const gate of incoming) this.addTurnGuestGate(gate);
      return;
    }

    this.turnGuestGates = [...incoming];

    const agent = this.agent!;
    await this.runTurn(text, 0, () => agent.prompt(text, images));
  }

  async resumeTurn(resumeCount: number, guestGates: TurnGuestGate[] = []): Promise<void> {
    if (!(await this.ensureAgentReady())) return;
    if (this.isBusy) return;
    this.turnGuestGates = [...guestGates];
    const agent = this.agent!;
    await this.runTurn('(resumed after reload)', resumeCount, () => {
      const messages = agent.state.messages;
      const last = messages[messages.length - 1] as Partial<AssistantMessage> | undefined;
      if (
        last?.role === 'assistant' &&
        (last.stopReason === 'error' || last.stopReason === 'aborted')
      ) {
        agent.state.messages = messages.slice(0, -1);
      }
      return agent.continue();
    });
  }

  settleInterruptedToolCalls(
    calls: ReadonlyArray<{ toolCallId: string; toolName: string; text: string }>
  ): void {
    const agent = this.agent;
    if (!agent || calls.length === 0) return;
    const now = Date.now();
    const results: ToolResultMessage[] = calls.map((call) => ({
      role: 'toolResult',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      content: [{ type: 'text', text: call.text }],
      isError: true,
      timestamp: now,
    }));
    agent.state.messages = [...agent.state.messages, ...results];
    this.sessions.persistNow();
    for (const call of calls) {
      this.callbacks.onToolEnd?.(call.toolName, call.text, true, call.toolCallId);
    }
  }

  reportError(message: string): void {
    this.callbacks.onError(message);
  }

  hasAgent(): boolean {
    return this.agent !== null;
  }

  private async runTurn(
    text: string,
    resumeCount: number,
    start: () => Promise<void>
  ): Promise<void> {
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
    this.turnJournal?.begin(this.scoop.jid, this.scoop.folder, resumeCount, this.turnGuestGates);

    let lastError: Error | null = null;
    try {
      lastError = await this.turnRunner.run(start, abortSignal);

      if (lastError && !this.disposed && !abortSignal.aborted) {
        this.turnRunner.reportExhausted(lastError);
        return;
      }

      if (!this.disposed && !abortSignal.aborted && this.status !== 'error') {
        this.setStatus('ready');
      }
    } finally {
      this.cleanupPromptState(abortController, turnProcess, lastError, abortSignal);
    }
  }

  private addTurnGuestGate(gate: TurnGuestGate): void {
    const key = JSON.stringify(gate);
    if (this.turnGuestGates.some((existing) => JSON.stringify(existing) === key)) return;
    this.turnGuestGates.push(gate);
    this.turnJournal?.setGuestGates(this.scoop.jid, this.turnGuestGates);
  }

  stop(): void {
    signalTurnProcess(
      this.processManager,
      this.currentTurnProcess,
      'SIGINT',
      this.promptAbortController
    );
    this.agent?.clearAllQueues?.();
    this.agent?.abort?.();

    this.idleCompaction?.cancel();
    this.isProcessing = false;

    if (this.status !== 'error') this.setStatus('ready');
  }

  clearMessages(): void {
    if (this.agent) {
      this.agent.state.messages = [];
    }
  }

  async clearSession(options: ClearSessionOptions = {}): Promise<void> {
    this.sessionGeneration++;
    this.idleCompaction?.cancel();
    this.clearMessages();
    await this.sessions.clear();
    await this.settleLiveSnapshot(options.discardLiveSnapshot === true);
  }

  private idleCompactionEnabled(): boolean {
    if (isGelatiereUnit(this.scoop)) return true;
    return this.unit.parentId === null && isFeatureEnabled('compact-on-idle');
  }

  private armIdleCompaction(): void {
    if (!this.idleCompactionEnabled()) {
      this.idleCompaction?.disarm();
      return;
    }
    if (this.idleCompaction) {
      this.idleCompaction.arm();
      return;
    }
    this.idleCompactionLoading ??= this.loadIdleCompaction();
    void this.idleCompactionLoading.then((idle) => {
      if (!this.disposed && this.status === 'ready') idle.arm();
    });
  }

  private async loadIdleCompaction(): Promise<IdleCompaction> {
    const [{ IdleCompaction }, { readIdleCompactionSettings }] = await Promise.all([
      import('./scoop-context/idle-compaction.js'),
      import('../core/idle-compaction-settings.js'),
    ]);
    const idle = new IdleCompaction({
      isEnabled: () => this.idleCompactionEnabled(),
      getSettings: readIdleCompactionSettings,
      getAgent: () => this.agent,
      isDisposed: () => this.disposed,
      isBusy: () => this.isBusy,
      getCompactFn: () => this.compactFn,
      getCompactionApiKey: () => this.getCompactionApiKey?.(),
      estimateTokens: estimateConversationTokens,

      onCompacted: () => this.sessions.persistNow(),

      onDiscarded: (roundId) =>
        this.callbacks.onCompactionStateChange?.('cancelled', { trigger: 'idle', roundId }),
      folder: this.scoop.folder,
    });
    this.idleCompaction = idle;
    return idle;
  }

  private async maybeSnapshotBeforeCompaction(
    messages: AgentMessage[],
    trigger: CompactionTrigger
  ): Promise<CompactionSnapshot | undefined> {
    if (this.unit.parentId !== null && !isFeatureEnabled('memory-v2')) return undefined;
    return this.snapshotBeforeCompaction(messages, trigger);
  }

  private async snapshotBeforeCompaction(
    messages: AgentMessage[],
    trigger: CompactionTrigger
  ): Promise<CompactionSnapshot | undefined> {
    if (!this.fs || this.disposed) return undefined;
    const generation = this.sessionGeneration;
    const { scoopSessionsDir, snapshotLiveSession } = await import('./live-session-snapshot.js');
    const isRoot = this.unit.parentId === null;
    const result = await snapshotLiveSession({
      vfs: this.fs,
      cone: { folder: this.scoop.folder, label: this.scoop.assistantLabel },
      messages,
      trigger,

      ...(isRoot ? {} : { sessionsDir: scoopSessionsDir(this.scoop.folder, this.scoop.jid) }),
      stillValid: () => !this.disposed && generation === this.sessionGeneration,
    });
    return result ? { transcriptPath: result.transcriptPath } : undefined;
  }

  private async settleLiveSnapshot(discard: boolean): Promise<void> {
    if (this.unit.parentId !== null || !this.fs) return;
    try {
      const { discardLiveSnapshot, finalizeLiveSnapshot } = await import(
        './live-session-snapshot.js'
      );
      if (discard) await discardLiveSnapshot(this.fs, this.scoop.folder);
      else await finalizeLiveSnapshot(this.fs, this.scoop.folder);
    } catch (err) {
      log.warn('Live snapshot settle failed (archive stays live)', {
        folder: this.scoop.folder,
        discard,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getAgentMessages(): AgentMessage[] {
    return this.agent?.state?.messages ? structuredClone(this.agent.state.messages) : [];
  }

  getContextFill(): number {
    return estimateContextFill(this.agent?.state?.messages ?? [], this.scoop);
  }

  getSessionId(): string {
    return this.sessions.sessionId;
  }

  getFS(): VirtualFS | RestrictedFS | null {
    return this.fs;
  }

  getShell(): AlmostBashShellHeadless | null {
    return this.shell;
  }

  updateModel(): void {
    if (!this.agent) return;
    this.activeEffortOverride = applyModelUpdate(this.agent, this.scoop);
  }

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

  setThinkingLevel(level: ThinkingLevel | undefined, effortOverride?: string): ThinkingLevel {
    if (!this.agent) return 'off';
    if (getLockedEffortLevel()) return this.agent.state.thinkingLevel;
    this.activeEffortOverride = effortOverride;
    return applyThinkingLevel(this.agent, level);
  }

  getThinkingLevel(): ThinkingLevel {
    return this.agent?.state.thinkingLevel ?? 'off';
  }

  dispose(): void {
    this.sessions.persistNow();

    this.turnJournal?.end(this.scoop.jid);
    this.disposed = true;
    this.idleCompaction?.cancel();

    this.runBounds.disarm();

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

    this.unsubscribe = null;
    this.shell?.dispose();
    this.compactFn = null;
    this.getCompactionApiKey = null;
    this.agent = null;
    this.shell = null;
    this.fs = null;
  }

  private handleAgentEvent(event: CoreAgentEvent, abortSignal?: AbortSignal): Promise<void> | void {
    if (this.disposed) return;
    return routeAgentEvent(event, this.eventSink, abortSignal);
  }

  private async makeToolCallDurable(
    toolName: string,
    args: unknown,
    toolCallId: string | undefined
  ): Promise<void> {
    const writes = Promise.all([
      this.sessions.flush(),
      toolCallId ? this.turnJournal?.toolStarted(this.scoop.jid, toolCallId, toolName, args) : null,
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), TOOL_DURABILITY_WAIT_MS);
    });
    try {
      if ((await Promise.race([writes, deadline])) === 'timeout') {
        log.warn('Tool call not yet durable; running it anyway', {
          folder: this.scoop.folder,
          toolName,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private checkpoint(message?: AgentMessage): void {
    const role = (message as { role?: unknown } | undefined)?.role;
    if (role === 'user') {
      this.sessions.persistNow();
    } else if (role === 'toolResult') {
      const { toolCallId } = message as ToolResultMessage;
      void this.sessions
        .flush()
        .then(() => this.turnJournal?.toolEnded(this.scoop.jid, toolCallId));
    } else {
      this.sessions.schedule();
    }
  }

  private setStatus(status: 'initializing' | 'ready' | 'processing' | 'error'): void {
    if (this.disposed) return;
    this.status = status;

    if (status === 'ready') this.armIdleCompaction();
    else this.idleCompaction?.cancel();
    this.callbacks.onStatusChange(status);
  }

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
