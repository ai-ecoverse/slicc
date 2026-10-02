import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { BlindReadLog } from '../../base/blind-reads.js';
import { providerLabel } from '../../base/provider-labels.js';
import {
  adaptTools,
  createLogger,
  type ToolAdapterGateConfig,
  type ToolAdapterSecretsConfig,
} from '../../core/index.js';
import { getToolResultScrubber } from '../../core/secret-scrub.js';
import type { VirtualFS } from '../../fs/index.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import { resolveModelSelectionForScoop } from '../../providers/account-store.js';
import type { AlmostBashShellHeadless } from '../../shell/almost-bash-shell-headless.js';
import type { SudoDecision, SudoRequest, TurnGuestGate } from '../../sudo/types.js';
import {
  createBashTool,
  createFileTools,
  createMemoryWriteTool,
  createRequestSecretTool,
} from '../../tools/index.js';
import type { BashJobProcess, ToolDefinition } from '../../tools/types.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import { effectiveToolSurface } from '../agent-tool-surface.js';
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

  memoryFs: VirtualFS;

  blindReads?: BlindReadLog | null;

  onSudoRequest?: (request: SudoRequest) => Promise<SudoDecision>;
  processManager: ProcessManager | null;
  processOwner: ProcessOwner;
  getTurnPid: () => number | undefined;

  lickTarget: string | undefined;

  onStructuredOutput: (value: unknown) => void;

  spawnBashJob: (command: string) => BashJobProcess | null;

  getTurnGuestGates: () => readonly TurnGuestGate[];
  getTurnSignal?: () => AbortSignal | undefined;
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

async function buildReducedTools(deps: ScoopToolsDeps) {
  const schema = deps.scoop.config?.structuredOutputSchema;
  if (effectiveToolSurface(deps.scoop.config) !== 'output' || !schema) {
    return adaptToolList(deps, []);
  }
  const { createStructuredOutputTool } = await import('../structured-output-tool.js');
  return adaptToolList(deps, [createStructuredOutputTool(schema, deps.onStructuredOutput)]);
}

function adaptToolList(deps: ScoopToolsDeps, legacyTools: ToolDefinition[]) {
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

export async function buildScoopTools(deps: ScoopToolsDeps) {
  if (effectiveToolSurface(deps.scoop.config) !== 'full') {
    return buildReducedTools(deps);
  }
  const { scoop, unit, callbacks } = deps;
  const scoopManagementToolsConfig: ScoopManagementToolsConfig = {
    scoop,
    getTurnSignal: deps.getTurnSignal,
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
    onSudoRequest: deps.onSudoRequest ?? callbacks.onSudoRequest,
    onSudoResolve: callbacks.onSudoResolve,
    onListSudoRequests: callbacks.onListSudoRequests,
  };
  const scoopManagementTools = createScoopManagementTools(scoopManagementToolsConfig);
  const fileTools = createFileTools(deps.gatedFs, unit.workspace.root);

  const blindReads = deps.blindReads ?? null;
  const memoryWriteTool = createMemoryWriteTool(deps.memoryFs, {
    readSessionCount: async () => {
      const { readSessionCount } = await import('../cone-memory-budget.js');
      return readSessionCount(deps.fs);
    },

    ...(blindReads ? { blindPaths: () => blindReads.outsidePaths() } : {}),
  });

  const legacyTools = [
    ...fileTools,
    memoryWriteTool,

    createBashTool(deps.shell, deps.fs, unit.workspace.scratch, {
      defaultBackgroundAfterSeconds: scoop.config?.backgroundAfterSeconds,

      targetScoop: deps.lickTarget,

      jobHost: { spawn: (command) => deps.spawnBashJob(command) },

      scrubOutput: getToolResultScrubber(),

      ...(blindReads ? { annotateResult: () => blindReads.takeNote() } : {}),

      fireLick: (event) => {
        const handler = (globalThis as SliccLickGlobal).__slicc_lick_handler;
        if (!handler) {
          log.warn('No lick handler for background bash completion', {
            folder: scoop.folder,
          });
          return false;
        }
        handler(event);
        return true;
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
  const adapted = deps.processManager
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

  const mcpTools = await buildMcpAgentTools(deps.fs, scoop);
  const gatedMcpTools = wrapMcpToolsWithGateAndScrub(mcpTools, gateConfig, secretsConfig);
  return [...adapted, ...gatedMcpTools];
}

async function buildMcpAgentTools(
  fs: VirtualFS,
  scoop: RegisteredScoop
): Promise<import('@earendil-works/pi-agent-core').AgentTool[]> {
  try {
    if (scoop.parentJid !== null) return [];

    const { listServers } = await import('../../shell/mcp/store.js');
    const servers = await listServers(fs as Parameters<typeof listServers>[0]);
    const entries = Object.entries(servers);
    if (entries.length === 0) return [];

    const relevantEntries = entries.filter(([, entry]) => {
      const exposure = entry.exposure ?? 'codemode';
      return (
        exposure === 'direct' ||
        exposure === 'codemode' ||
        exposure === 'codemode-deferred' ||
        hasExposureOverrides(entry)
      );
    });
    if (relevantEntries.length === 0) return [];

    const { toAgentTools } = await import('../../shell/mcp/agent-tools.js');

    const manager = await getOrCreateConnectionManager();
    const allTools: import('@earendil-works/pi-agent-core').AgentTool[] = [];

    for (const [name, entry] of relevantEntries) {
      try {
        const { connection, transport } = await manager.connect(name, entry);
        if (transport !== entry.transport) {
          entry.transport = transport;
          import('../../shell/mcp/store.js')
            .then(({ setServer }) => setServer(name, entry, fs))
            .catch(() => {});
        }
        const tools = entry.tools ?? (await connection.listTools());
        const piTools = (tools as import('@earendil-works/pi-mcp').Tool[]) ?? [];

        const directTools = toAgentTools({
          serverName: name,
          tools: piTools,
          connection,
          exposure: entry.exposure,
          toolExposure: entry.toolExposure,
          writeOverflow: async (id, text) => {
            try {
              await fs.mkdir('/tmp/mcp', { recursive: true });
              await fs.writeFile(`/tmp/mcp/${id}.txt`, text);
            } catch {}
          },
        });
        allTools.push(...directTools);

        const codemodeTool = await buildCodemodeTool(name, piTools, connection, entry);
        if (codemodeTool) allTools.push(codemodeTool);
      } catch (err) {
        log.warn('failed to load MCP tools for agent', {
          server: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return allTools;
  } catch (err) {
    log.debug('MCP agent tools unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function buildCodemodeTool(
  serverName: string,
  tools: import('@earendil-works/pi-mcp').Tool[],
  connection: import('../../shell/mcp/connection-manager.js').McpConnection,
  entry: import('../../shell/mcp/types.js').McpServerEntry
): Promise<import('@earendil-works/pi-agent-core').AgentTool | null> {
  try {
    const { createCodemodeAgentTool } = await import('../../shell/mcp/codemode-tool.js');
    return createCodemodeAgentTool({
      serverName,
      tools,
      connection,
      exposure: entry.exposure,
      toolExposure: entry.toolExposure,
    });
  } catch (err) {
    log.debug('codemode tool unavailable for server', {
      server: serverName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function checkMcpToolGate(
  toolName: string,
  params: unknown,
  gateConfig: ToolAdapterGateConfig,
  signal?: AbortSignal
): Promise<AgentToolResult | null> {
  const gate = gateConfig.currentGate();
  if (!gate) return null;
  if (signal?.aborted) {
    return {
      content: [{ type: 'text', text: `${toolName}: not approved (guest-caused turn).` }],
      details: undefined,
    };
  }
  let allowed: boolean;
  try {
    allowed = await gate.approve(toolName, params);
  } catch {
    allowed = false;
  }
  if (!allowed || signal?.aborted) {
    return {
      content: [{ type: 'text', text: `${toolName}: not approved (guest-caused turn).` }],
      details: undefined,
    };
  }
  return null;
}

async function scrubMcpToolResult(
  result: AgentToolResult,
  scrub: ToolAdapterSecretsConfig['scrubToolResult']
): Promise<void> {
  if (!scrub) return;
  for (let i = 0; i < result.content.length; i++) {
    const block = result.content[i];
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      try {
        const scrubbed = await scrub(block.text);
        if (scrubbed !== block.text) result.content[i] = { type: 'text', text: scrubbed };
      } catch {}
    }
  }
}

function wrapMcpToolsWithGateAndScrub(
  tools: AgentTool[],
  gateConfig: ToolAdapterGateConfig,
  secretsConfig: ToolAdapterSecretsConfig
): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult) => void
    ): Promise<AgentToolResult> {
      const denied = await checkMcpToolGate(tool.name, params, gateConfig, signal);
      if (denied) return denied;
      const result = await tool.execute(toolCallId, params, signal, onUpdate);
      await scrubMcpToolResult(result, secretsConfig.scrubToolResult);
      return result;
    },
  }));
}

function hasExposureOverrides(entry: import('../../shell/mcp/types.js').McpServerEntry): boolean {
  if (!entry.toolExposure) return false;
  return Object.values(entry.toolExposure).some(
    (mode) => mode === 'direct' || mode === 'codemode' || mode === 'codemode-deferred'
  );
}

type McpConnectionManagerType =
  import('../../shell/mcp/connection-manager.js').McpConnectionManager;
let sharedManager: McpConnectionManagerType | null = null;

export async function getOrCreateConnectionManager(): Promise<McpConnectionManagerType> {
  if (sharedManager) return sharedManager;
  const { McpConnectionManager } = await import('../../shell/mcp/connection-manager.js');
  sharedManager = new McpConnectionManager({
    getAuthHeader: async (serverName) => {
      try {
        const { getOAuthAccountInfo } = await import('../../providers/account-store.js');
        const info = getOAuthAccountInfo(`mcp:${serverName}`);
        if (!info) return null;
        return `Bearer ${info.token}`;
      } catch {
        return null;
      }
    },
  });
  return sharedManager;
}
