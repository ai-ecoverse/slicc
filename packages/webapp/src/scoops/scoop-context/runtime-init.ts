import type { CompactionConfig } from '../../core/context-compaction.js';
import type { Agent } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import type { VirtualFS } from '../../fs/index.js';
import type { RestrictedFS } from '../../fs/restricted-fs.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import type { AlmostBashShellHeadless } from '../../shell/almost-bash-shell-headless.js';
import type { SudoManager } from '../../sudo/sudo-manager.js';
import type { TurnGuestGate } from '../../sudo/types.js';
import type { BashJobProcess } from '../../tools/types.js';
import type { CapabilityBroker } from '../../work-unit/capability/index.js';
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

  capabilityBroker: CapabilityBroker | null;
  processManager: ProcessManager | null;
  processOwner: ProcessOwner;
  coneJid: string | undefined;
  getTurnPid: () => number | undefined;

  getTurnGuestGates: () => readonly TurnGuestGate[];

  getLickTarget: () => string | undefined;

  getTmpDir: () => string;

  getEffortOverride: () => string | undefined;
  isDisposed: () => boolean;

  onShellReady: (shell: AlmostBashShellHeadless) => void;
  onStructuredOutput: (value: unknown) => void;
  spawnBashJob: (command: string) => BashJobProcess | null;

  onBeforeCompaction?: CompactionConfig['onBeforeCompaction'];
}

export type ScoopRuntime =
  | { kind: 'deferred' }
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

  const tmpDir = deps.getTmpDir();
  log.info('Filesystem ready', { folder: scoop.folder });
  await ensureDirectoryStructure(fs, scoop, unit, tmpDir);

  const { shell, gatedFs, memoryFs, skills } = await initShellAndSkills({
    scoop,
    unit,
    fs,
    tmpDir,
    skillsFs: deps.skillsFs,
    getBrowserAPI: callbacks.getBrowserAPI,
    sudoManager: deps.sudoManager,
    capabilityBroker: deps.capabilityBroker,
    onSudoRequest: callbacks.onSudoRequest,
    processManager: deps.processManager,
    processOwner: deps.processOwner,
    getTurnPid: deps.getTurnPid,
    lickTarget: deps.getLickTarget(),
  });
  deps.onShellReady(shell);

  const tools = await buildScoopTools({
    getTurnGuestGates: deps.getTurnGuestGates,
    scoop,
    unit,
    callbacks,
    shell,
    fs: fs as VirtualFS,
    gatedFs,
    memoryFs,
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
    onCompactionStateChange: (state, detail) => callbacks.onCompactionStateChange?.(state, detail),
    onBeforeCompaction: deps.onBeforeCompaction,
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
    onContextCompacted: () => deps.sessions.persistNow(),
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
