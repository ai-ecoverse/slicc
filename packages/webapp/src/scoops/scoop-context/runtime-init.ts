/**
 * One-time assembly of a work unit's runtime.
 *
 * Owns: the ORDER of init — directories, shell + skills, tools, memories,
 * model, system prompt, restored history, session helpers, agent — and the
 * two non-error early exits (no credential yet; disposed mid-init).
 *
 * Changes when a new stage joins that sequence or an existing one moves. The
 * facade keeps only the outcome (`setStatus` / `onError`), so a reader asking
 * "what does booting a unit involve?" gets one linear answer instead of a
 * method that also owned retries, bounds and recovery.
 */

import type { Agent } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import type { VirtualFS } from '../../fs/index.js';
import type { RestrictedFS } from '../../fs/restricted-fs.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import type { AlmostBashShellHeadless } from '../../shell/almost-bash-shell-headless.js';
import type { SudoManager } from '../../sudo/sudo-manager.js';
import type { TurnGuestGate } from '../../sudo/types.js';
import type { BashJobProcess } from '../../tools/types.js';
import { thinkingFor } from '../../work-unit/record.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { RegisteredScoop } from '../types.js';
import { createScoopAgent } from './agent-factory.js';
import type { ScoopContextCallbacks } from './callbacks.js';
import { ensureDirectoryStructure } from './directory-structure.js';
import { loadMemories } from './memories.js';
import { getModelApiKey, resolveModelForInit } from './model-resolution.js';
import type { CompactFn } from './overflow-recovery.js';
import { buildSessionHelpers } from './session-helpers.js';
import type { SessionPersistence } from './session-persistence.js';
import { initShellAndSkills } from './shell-and-skills.js';
import { buildScoopSystemPrompt } from './system-prompt.js';
import { getLockedEffortLevel, resolveThinkingLevel } from './thinking-level.js';
import { buildScoopTools } from './tools.js';

const log = createLogger('scoop-context');

export interface RuntimeInitDeps {
  scoop: RegisteredScoop;
  unit: WorkUnitDescriptor;
  fs: VirtualFS | RestrictedFS;
  skillsFs: VirtualFS | null;
  callbacks: ScoopContextCallbacks;
  sessions: SessionPersistence;
  sudoManager: SudoManager | null;
  processManager: ProcessManager | null;
  processOwner: ProcessOwner;
  coneJid: string | undefined;
  getTurnPid: () => number | undefined;
  /** Live lookup for the guest gate on the turn in flight (see `tools.ts`). */
  getTurnGuestGate: () => TurnGuestGate | undefined;
  /** Live, because the roster it derives from changes as roots come and go. */
  getLickTarget: () => string | undefined;
  /** Live, because the stream wrapper reads it per request. */
  getEffortOverride: () => string | undefined;
  isDisposed: () => boolean;
  /**
   * Called the moment the shell exists — BEFORE the remaining stages, so a
   * dispose mid-init still tears down a shell that was already created.
   */
  onShellReady: (shell: AlmostBashShellHeadless) => void;
  onStructuredOutput: (value: unknown) => void;
  spawnBashJob: (command: string) => BashJobProcess | null;
}

export type ScoopRuntime =
  /** No credential for this unit's provider yet — a deferred init, not a failure. */
  | { kind: 'deferred' }
  /** Disposed while the last stages were awaiting; nothing may be adopted. */
  | { kind: 'abandoned' }
  | {
      kind: 'ready';
      agent: Agent;
      compactFn: CompactFn;
      getCompactionApiKey: () => string | undefined;
      effortOverride: string | undefined;
      toolCount: number;
    };

export async function buildScoopRuntime(deps: RuntimeInitDeps): Promise<ScoopRuntime> {
  const { scoop, unit, fs, callbacks } = deps;

  log.info('Filesystem ready', { folder: scoop.folder });
  await ensureDirectoryStructure(fs, scoop, unit);

  const { shell, gatedFs, skills } = await initShellAndSkills({
    scoop,
    unit,
    fs,
    skillsFs: deps.skillsFs,
    getBrowserAPI: callbacks.getBrowserAPI,
    sudoManager: deps.sudoManager,
    onSudoRequest: callbacks.onSudoRequest,
    processManager: deps.processManager,
    processOwner: deps.processOwner,
    getTurnPid: deps.getTurnPid,
    lickTarget: deps.getLickTarget(),
  });
  deps.onShellReady(shell);

  const tools = await buildScoopTools({
    getTurnGuestGate: deps.getTurnGuestGate,
    scoop,
    unit,
    callbacks,
    shell,
    fs: fs as VirtualFS,
    gatedFs,
    processManager: deps.processManager,
    processOwner: deps.processOwner,
    getTurnPid: deps.getTurnPid,
    lickTarget: deps.getLickTarget(),
    onStructuredOutput: deps.onStructuredOutput,
    spawnBashJob: deps.spawnBashJob,
  });
  const { scoopMemory, globalMemory } = await loadMemories(fs, unit, () =>
    callbacks.getGlobalMemory()
  );

  if (!getModelApiKey(scoop)) {
    log.info('ScoopContext init deferred — no API key yet', { folder: scoop.folder });
    return { kind: 'deferred' };
  }

  const model = resolveModelForInit(scoop, unit);
  const systemPrompt = buildScoopSystemPrompt(scoop, unit, globalMemory, scoopMemory, skills);
  const restoredMessages = await deps.sessions.restore();
  const { streamWithSessionId, compactFn, getCompactionApiKey } = await buildSessionHelpers(model, {
    scoop,
    unit,
    coneJid: deps.coneJid,
    getModelApiKey: () => getModelApiKey(scoop),
    getEffortOverride: deps.getEffortOverride,
    appendConeMemory: callbacks.appendConeMemory,
    onCompactionStateChange: (state) => callbacks.onCompactionStateChange?.(state),
  });

  if (deps.isDisposed()) return { kind: 'abandoned' };

  const thinking = thinkingFor(scoop);
  const agent = createScoopAgent({
    model,
    tools,
    systemPrompt,
    messages: restoredMessages,
    thinkingLevel: resolveThinkingLevel(getLockedEffortLevel() ?? thinking.level, model),
    getApiKey: () => getModelApiKey(scoop) ?? undefined,
    transformContext: compactFn,
    streamFn: streamWithSessionId,
    captureStructuredOutput: scoop.config?.structuredOutputSchema
      ? deps.onStructuredOutput
      : undefined,
  });

  return {
    kind: 'ready',
    agent,
    compactFn,
    getCompactionApiKey,
    effortOverride: thinking.effortOverride,
    toolCount: tools.length,
  };
}
