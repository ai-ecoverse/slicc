import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { classifyImageMarkers } from '../base/image-markers.js';
import { createLogger } from '../base/logger.js';
import type { ProcessManager, ProcessOwner } from '../kernel/process-manager.js';
import {
  popToolExecutionContext,
  pushToolExecutionContext,
  type ToolExecutionContext,
} from '../tools/tool-ui.js';
import type { ToolDefinition } from '../tools/types.js';
import { processImageContent } from './image-processor.js';
import type { ImageContent, TextContent } from './types.js';

const log = createLogger('tool-adapter');

export function parseToolResultContentRaw(text: string): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = [];
  let lastIndex = 0;

  for (const found of classifyImageMarkers(text)) {
    if (found.kind === 'inert' || !found.parsed) continue;

    const before = text.slice(lastIndex, found.index);
    if (before.trim()) {
      blocks.push({ type: 'text', text: before.trimEnd() });
    }

    blocks.push({
      type: 'image',
      mimeType: found.parsed.mimeType,
      data: found.parsed.data,
    });
    lastIndex = found.index + found.marker.length;
  }

  const remaining = text.slice(lastIndex);
  if (remaining.trim() || blocks.length === 0) {
    blocks.push({ type: 'text', text: remaining || text });
  }

  return blocks;
}

export async function parseToolResultContent(
  text: string
): Promise<(TextContent | ImageContent)[]> {
  const raw = parseToolResultContentRaw(text);

  const processed: (TextContent | ImageContent)[] = [];
  for (const block of raw) {
    if (block.type === 'image') {
      processed.push(await processImageContent(block));
    } else {
      processed.push(block);
    }
  }

  return processed;
}

export interface ToolAdapterProcessConfig {
  processManager: ProcessManager;
  owner: ProcessOwner;
  getParentPid?: () => number | undefined;
}

export interface ToolAdapterSecretsConfig {
  scrubToolResult: (text: string) => Promise<string>;
}

type TrackedToolProcess = {
  record: ReturnType<ProcessManager['spawn']>;
  manager: ProcessManager;
  unsubscribeKill: () => void;
};

function startToolProcess(
  tool: ToolDefinition,
  params: unknown,
  signal: AbortSignal | undefined,
  config: ToolAdapterProcessConfig | undefined
): { tracked: TrackedToolProcess | null; effectiveSignal: AbortSignal | undefined } {
  if (!config) return { tracked: null, effectiveSignal: signal };
  const record = config.processManager.spawn({
    kind: 'tool',
    argv: [tool.name, ...extractToolArg(params)],
    owner: config.owner,
    ppid: config.getParentPid?.(),
  });
  if (signal?.aborted) {
    config.processManager.signal(record.pid, 'SIGINT');
  } else if (signal) {
    signal.addEventListener('abort', () => config.processManager.signal(record.pid, 'SIGINT'), {
      once: true,
    });
  }
  const unsubscribeKill = config.processManager.onSignal((signaled, sig) => {
    if (signaled.pid !== record.pid || sig !== 'SIGKILL') return;
    config.processManager.exit(record.pid, null);
  });
  return {
    tracked: { record, manager: config.processManager, unsubscribeKill },
    effectiveSignal: record.abort.signal,
  };
}

function exitToolProcess(tracked: TrackedToolProcess | null, code: number | null): void {
  if (tracked) tracked.manager.exit(tracked.record.pid, code);
}

async function scrubToolResult(
  content: string,
  toolName: string,
  config: ToolAdapterSecretsConfig | undefined
): Promise<string> {
  if (!config || typeof content !== 'string' || content.length === 0) return content;
  try {
    return await config.scrubToolResult(content);
  } catch (err) {
    log.warn('Tool-result scrub failed, falling back to unscrubbed content', {
      tool: toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return content;
  }
}

async function parseToolResult(
  content: string,
  toolName: string
): Promise<(TextContent | ImageContent)[]> {
  try {
    return await parseToolResultContent(content);
  } catch (err) {
    log.warn('Image processing failed, falling back to raw content', {
      tool: toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return parseToolResultContentRaw(content);
  }
}

export interface ToolAdapterGateConfig {
  currentGate(): ToolCallGate | undefined;
}

export interface ToolCallGate {
  approve(toolName: string, params: unknown): Promise<boolean>;
}

async function passesGate(
  tool: ToolDefinition,
  params: unknown,
  config: ToolAdapterGateConfig | undefined,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const gate = config?.currentGate();
  if (!gate) return true;

  if (signal?.aborted) return false;
  try {
    const allowed = await gate.approve(tool.name, params);
    return allowed && signal?.aborted !== true;
  } catch (err) {
    log.warn('Tool-call gate threw — refusing the call', {
      tool: tool.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function adaptTool(
  tool: ToolDefinition,
  pmConfig?: ToolAdapterProcessConfig,
  secretsConfig?: ToolAdapterSecretsConfig,
  gateConfig?: ToolAdapterGateConfig
): AgentTool<any> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as any,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<any>) => void
    ): Promise<AgentToolResult<any>> {
      let ctx: ToolExecutionContext | undefined;
      if (onUpdate) {
        ctx = pushToolExecutionContext({ onUpdate, toolName: tool.name, toolCallId });
      }

      if (!(await passesGate(tool, params, gateConfig, signal))) {
        if (ctx) popToolExecutionContext(ctx);
        return {
          content: [{ type: 'text', text: `${tool.name}: not approved (guest-caused turn).` }],
          details: { isError: true },
        };
      }

      const process = startToolProcess(tool, params, signal, pmConfig);

      try {
        const result = await tool.execute(
          // biome-ignore lint/plugin: per-tool argument bag, shape declared by the tool's inputSchema.
          (params ?? {}) as Record<string, unknown>,
          process.effectiveSignal
        );
        const scrubbedText = await scrubToolResult(result.content, tool.name, secretsConfig);
        const content = await parseToolResult(scrubbedText, tool.name);
        exitToolProcess(process.tracked, result.isError ? 1 : 0);
        return {
          content,
          details: { isError: result.isError },
        };
      } catch (err) {
        exitToolProcess(process.tracked, process.tracked?.record.abort.signal.aborted ? null : 1);
        throw err;
      } finally {
        if (ctx) {
          popToolExecutionContext(ctx);
        }
        process.tracked?.unsubscribeKill();
      }
    },
  };
}

export function adaptTools(
  tools: ToolDefinition[],
  pmConfig?: ToolAdapterProcessConfig,
  secretsConfig?: ToolAdapterSecretsConfig,
  gateConfig?: ToolAdapterGateConfig
): AgentTool<any>[] {
  return tools.map((t) => adaptTool(t, pmConfig, secretsConfig, gateConfig));
}

export function extractToolArg(params: unknown): string[] {
  if (typeof params !== 'object' || params === null) return [];
  // biome-ignore lint/plugin: same per-tool argument bag; this probes a few well-known field names across every tool.
  const obj = params as Record<string, unknown>;

  const preferred = [
    'command',
    'file_path',
    'path',
    'pattern',
    'url',
    'key',
    'name',
    'query',
    'message',
  ];
  for (const key of preferred) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return [v];
    }
  }

  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length > 0) return [v];
  }
  return [];
}
