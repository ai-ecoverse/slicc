/**
 * The tool set one work unit's agent gets.
 *
 * Owns: assembling the file tools, the `bash` tool (with its background-job
 * host, lick routing and scrubbing), the scoop-management tools, the optional
 * structured-output tool, and the `adaptTools` process wiring.
 *
 * Changes whenever a tool is added, removed, or re-configured — the most
 * frequent kind of edit this file used to attract, and one that has no reason
 * to be read alongside the retry loop.
 */

import { adaptTools, createLogger, type ToolAdapterGateConfig } from '../../core/index.js';
import { getToolResultScrubber } from '../../core/secret-scrub.js';
import type { VirtualFS } from '../../fs/index.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import { resolveModelSelectionForScoop } from '../../providers/account-store.js';
import type { AlmostBashShellHeadless } from '../../shell/almost-bash-shell-headless.js';
import type { TurnGuestGate } from '../../sudo/types.js';
import { createBashTool, createFileTools } from '../../tools/index.js';
import type { BashJobProcess } from '../../tools/types.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { ScoopContextCallbacks } from '../scoop-context.js';
import {
  createScoopManagementTools,
  type ScoopManagementToolsConfig,
} from '../scoop-management-tools.js';
import type { RegisteredScoop } from '../types.js';

const log = createLogger('scoop-context');

/**
 * The orchestrator's lick sink, published on `globalThis` by
 * `Orchestrator.setLickManager` (the LickManager lives in the kernel worker,
 * the emitters are scattered across shell commands and tools). Mirrors the
 * `SliccGlobalHooks` shape in `orchestrator.ts`.
 */
type SliccLickGlobal = typeof globalThis & {
  __slicc_lick_handler?: (event: import('@slicc/shared-ts').LickEvent) => void;
};

export interface ScoopToolsDeps {
  scoop: RegisteredScoop;
  unit: WorkUnitDescriptor;
  callbacks: ScoopContextCallbacks;
  shell: AlmostBashShellHeadless;
  /** UNGATED filesystem — internal, fixed-path writes must not trip sudo. */
  fs: VirtualFS;
  /** Sudo-gated filesystem the agent's file tools operate on. */
  gatedFs: VirtualFS;
  processManager: ProcessManager | null;
  processOwner: ProcessOwner;
  getTurnPid: () => number | undefined;
  /** Route a detached job's completion lick back to THIS unit. */
  lickTarget: string | undefined;
  /** Sink for a `StructuredOutput` call's arguments. */
  onStructuredOutput: (value: unknown) => void;
  /** Register a background `bash` invocation as a kernel process. */
  spawnBashJob: (command: string) => BashJobProcess | null;
  /**
   * The gate for the turn in flight, read LIVE on every tool call. Tools are
   * built once per scoop; whether the current turn was caused by a guest is
   * not, so this must be a lookup and never a captured value.
   */
  getTurnGuestGates: () => readonly TurnGuestGate[];
}

/**
 * The per-tool-call gate for a guest-caused turn.
 *
 * Only the CHECK lives here — `currentGate()` runs on every tool call, so it
 * must stay synchronous and cheap. Everything that runs once a gate exists is
 * in `guest-tool-gate.ts` and imported on first use: this file is boot-critical
 * and the overwhelming majority of turns have no guest gate.
 */
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

/** Build tools for the agent. */
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
    // Bash output truncation writes its overflow file via the UNGATED fs (an
    // internal, fixed-path write must never trip a sudo prompt) into a temp dir
    // the context can also read back: `/tmp` for the cone, the scoop's own
    // writable root for a scoop (its sandbox excludes `/tmp`). Per-context dirs
    // also keep parallel scoops from colliding on the same filename.
    createBashTool(deps.shell, deps.fs, unit.workspace.scratch, {
      // Unset → the tool's own ten-minute default.
      defaultBackgroundAfterSeconds: scoop.config?.backgroundAfterSeconds,
      // Route a detached job's completion lick back to THIS unit. Only the
      // primary cone leaves it unset — it is where untargeted licks land.
      targetScoop: deps.lickTarget,
      // Every invocation becomes a kernel pid, so `timeout` is a real kill
      // (SIGKILL fans out to realm workers) and a detached job stays visible
      // to `ps` / reachable by `kill`.
      jobHost: { spawn: (command) => deps.spawnBashJob(command) },
      // A detached job's output skips the `adaptTools` tool-result boundary
      // (it arrives as a lick, not a tool result), so the same real→masked
      // pass is wired in here.
      scrubOutput: getToolResultScrubber(),
      // Same sink `fswatch` uses to raise a lick from inside the shell: the
      // orchestrator publishes it in `setLickManager`. Read per event rather
      // than captured once, so a context built before the lick manager was
      // attached still delivers.
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
