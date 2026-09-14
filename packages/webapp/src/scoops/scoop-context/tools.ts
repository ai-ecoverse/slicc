import { providerLabel } from '../../base/provider-labels.js';
import { adaptTools, createLogger, type ToolAdapterGateConfig } from '../../core/index.js';
import { getToolResultScrubber } from '../../core/secret-scrub.js';
import type { VirtualFS } from '../../fs/index.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import { resolveModelSelectionForScoop } from '../../providers/account-store.js';
import type { AlmostBashShellHeadless } from '../../shell/almost-bash-shell-headless.js';
import type { TurnGuestGate } from '../../sudo/types.js';
import { createBashTool, createFileTools, createRequestSecretTool } from '../../tools/index.js';
import type { BashJobProcess } from '../../tools/types.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { ScoopContextCallbacks } from '../scoop-context.js';
import {
  createScoopManagementTools,
  type ScoopManagementToolsConfig,
} from '../scoop-management-tools.js';
import type { RegisteredScoop } from '../types.js';
import { resolveScoopModel } from './model-resolution.js';

const log = createLogger('scoop-context');

type SliccLickGlobal = typeof globalThis & {
  __slicc_lick_handler?: (event: import('@slicc/shared-ts').LickEvent) => void;
};

export interface ScoopToolsDeps {
  scoop: RegisteredScoop;
  unit: WorkUnitDescriptor;
  callbacks: ScoopContextCallbacks;
  shell: AlmostBashShellHeadless;

  fs: VirtualFS;

  gatedFs: VirtualFS;
  processManager: ProcessManager | null;
  processOwner: ProcessOwner;
  getTurnPid: () => number | undefined;

  lickTarget: string | undefined;

  onStructuredOutput: (value: unknown) => void;

  spawnBashJob: (command: string) => BashJobProcess | null;

  getTurnGuestGates: () => readonly TurnGuestGate[];
}

function buildGuestToolGate(deps: ScoopToolsDeps): ToolAdapterGateConfig {
  return {
    currentGate() {
      const gates = deps.getTurnGuestGates();
      if (gates.length === 0) return undefined;
      return {
        async approve(toolName: string, params: unknown): Promise<boolean> {
          const { approveToolCallForGuests } = await import('./guest-tool-gate.js');
          return approveToolCallForGuests(
            gates,
            toolName,
            params,
            deps.callbacks.approveGuestToolCall
          );
        },
      };
    },
  };
}

export async function buildScoopTools(deps: ScoopToolsDeps) {
  const { scoop, unit, callbacks } = deps;
  const scoopManagementToolsConfig: ScoopManagementToolsConfig = {
    scoop,
    onSendMessage: callbacks.onSendMessage,
    getScoops: callbacks.getScoops,
    getScoopTabState: callbacks.getScoopTabState,
    onFeedScoop: callbacks.onFeedScoop,
    onScoopScoop: callbacks.onScoopScoop,
    resolveModelSelection: resolveModelSelectionForScoop,
    onDropScoop: callbacks.onDropScoop,
    onMuteScoops: callbacks.onMuteScoops,
    onUnmuteScoops: callbacks.onUnmuteScoops,
    onScheduleScoopWait: callbacks.onScheduleScoopWait,
    onSetGlobalMemory: callbacks.setGlobalMemory,
    getGlobalMemory: callbacks.getGlobalMemory,
    onSudoRequest: callbacks.onSudoRequest,
    onSudoResolve: callbacks.onSudoResolve,
    onListSudoRequests: callbacks.onListSudoRequests,
  };
  const scoopManagementTools = createScoopManagementTools(scoopManagementToolsConfig);

  const legacyTools = [
    ...createFileTools(deps.gatedFs),

    createBashTool(deps.shell, deps.fs, unit.workspace.scratch, {
      defaultBackgroundAfterSeconds: scoop.config?.backgroundAfterSeconds,

      targetScoop: deps.lickTarget,

      jobHost: { spawn: (command) => deps.spawnBashJob(command) },

      scrubOutput: getToolResultScrubber(),

      fireLick: (event) => {
        const handler = (globalThis as SliccLickGlobal).__slicc_lick_handler;
        if (!handler) {
          log.warn('No lick handler for background bash completion', {
            folder: scoop.folder,
          });
          return;
        }
        handler(event);
      },
    }),
    ...scoopManagementTools,

    createRequestSecretTool({
      requester: scoop.assistantLabel || scoop.name,
      setEnv: (name, maskedValue) => deps.shell.setMaskedEnvVar(name, maskedValue),

      getProvider: () => providerLabel(resolveScoopModel(scoop).provider),
    }),
  ];

  if (scoop.config?.structuredOutputSchema) {
    const { createStructuredOutputTool } = await import('../structured-output-tool.js');
    legacyTools.push(
      createStructuredOutputTool(scoop.config.structuredOutputSchema, deps.onStructuredOutput)
    );
  }

  const secretsConfig = { scrubToolResult: getToolResultScrubber() };
  const gateConfig = buildGuestToolGate(deps);
  return deps.processManager
    ? adaptTools(
        legacyTools,
        {
          processManager: deps.processManager,
          owner: deps.processOwner,
          getParentPid: deps.getTurnPid,
        },
        secretsConfig,
        gateConfig
      )
    : adaptTools(legacyTools, undefined, secretsConfig, gateConfig);
}
