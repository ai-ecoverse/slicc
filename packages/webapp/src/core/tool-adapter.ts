/**
 * Tool adapter — wraps legacy ToolDefinition as pi-compatible AgentTool.
 *
 * The existing tools in packages/webapp/src/tools/ return ToolDefinition objects with a
 * simple execute(input) → ToolResult API. This adapter converts them to
 * AgentTool objects with the pi-compatible execute signature:
 *   execute(toolCallId, params, signal?, onUpdate?) → AgentToolResult
 */

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

/**
 * Parse a tool result string, extracting `<img:...>` tags into ImageContent blocks.
 * Sync version — extracts tags without image processing.
 *
 * Only markers carrying a real base64 payload become image blocks; an
 * `unsupported` MIME type still does, so {@link processImageContent} can
 * replace it with a one-line placeholder instead of leaking the payload.
 * Marker-shaped prose and markers sliced mid-payload stay text — reporting
 * those as an unsupported image format names the wrong cause (#2217).
 */
export function parseToolResultContentRaw(text: string): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = [];
  let lastIndex = 0;

  for (const found of classifyImageMarkers(text)) {
    if (found.kind === 'inert' || !found.parsed) continue;
    // Add any text before this match
    const before = text.slice(lastIndex, found.index);
    if (before.trim()) {
      blocks.push({ type: 'text', text: before.trimEnd() });
    }
    // Add the image as a proper content block
    blocks.push({
      type: 'image',
      mimeType: found.parsed.mimeType,
      data: found.parsed.data,
    });
    lastIndex = found.index + found.marker.length;
  }

  // Add any remaining text after the last match
  const remaining = text.slice(lastIndex);
  if (remaining.trim() || blocks.length === 0) {
    blocks.push({ type: 'text', text: remaining || text });
  }

  return blocks;
}

/**
 * Parse a tool result string, extracting `<img:...>` tags into ImageContent blocks,
 * then validate and resize any images that exceed API limits.
 */
export async function parseToolResultContent(
  text: string
): Promise<(TextContent | ImageContent)[]> {
  const raw = parseToolResultContentRaw(text);

  // Process each image block through validation/resize
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

/**
 * Optional process-tracking config for `adaptTool` / `adaptTools`.
 * When supplied, every tool execution registers a `kind:'tool'`
 * process whose `Process.abort` is wired to the `signal` passed by
 * the agent loop. The process exits with 0 on clean return, the
 * signal-derived code (130 SIGINT, 143 SIGTERM, …) on abort, and
 * 1 on a thrown error.
 *
 * `getParentPid` returns the parent scoop-turn pid the tool runs
 * under. `ScoopContext` provides a closure that reads the current
 * turn's pid; tests can return any pid. When the closure returns
 * `undefined`, the manager defaults `ppid` to 1 (kernel-host
 * anchor) — `ps -T` would show the tool as an orphan but it'd
 * still be visible.
 */
export interface ToolAdapterProcessConfig {
  processManager: ProcessManager;
  owner: ProcessOwner;
  getParentPid?: () => number | undefined;
}

/**
 * Optional secrets config for `adaptTool` / `adaptTools`. When
 * supplied, the adapter runs a single real→masked scrub pass over
 * the completed tool-result text before parsing it into agent
 * content blocks. The scrub is the defense-in-depth tool-output
 * boundary that complements env-var masking and the fetch-proxy
 * inbound scrub — the agent never sees real secret values even if
 * a tool happens to produce them.
 *
 * Direction is real→masked ONLY (`SecretsPipeline.scrubResponse`),
 * so the pass is idempotent: already-masked tokens and secret-free
 * output round-trip unchanged. The scrub runs once on the completed
 * buffer; no streaming reassembly.
 */
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

/**
 * Optional per-tool-call approval gate.
 *
 * Wired at `adaptTool` because this is the ONE place every tool call passes
 * through — the abort signal is already threaded here, and gating anywhere else
 * would mean touching each tool and missing the next one added.
 *
 * `shouldGate` is consulted LIVE on every call rather than captured when the
 * tool set is built: tools are built once per scoop, but the thing being gated
 * is a property of the current TURN (was it caused by a guest?), which changes
 * underneath a long-lived tool set.
 *
 * A denial is returned as an error RESULT, not thrown: the agent should be able
 * to read "that was refused" and choose something else, and a throw would
 * abort the whole turn rather than the one action.
 */
export interface ToolAdapterGateConfig {
  /** The gate for the turn in flight, or undefined when nothing is gated. */
  currentGate(): ToolCallGate | undefined;
}

export interface ToolCallGate {
  /** Ask the human / cone / scoop. Resolves `false` to refuse the call. */
  approve(toolName: string, params: unknown): Promise<boolean>;
}

/**
 * Run the gate for one call. Fails CLOSED: a throwing gate refuses, because a
 * gate that errored has not approved anything.
 */
async function passesGate(
  tool: ToolDefinition,
  params: unknown,
  config: ToolAdapterGateConfig | undefined
): Promise<boolean> {
  const gate = config?.currentGate();
  if (!gate) return true;
  try {
    return await gate.approve(tool.name, params);
  } catch (err) {
    log.warn('Tool-call gate threw — refusing the call', {
      tool: tool.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Wrap a legacy ToolDefinition as a pi-compatible AgentTool.
 */
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
      // Push execution context so shell commands can show UI if needed
      let ctx: ToolExecutionContext | undefined;
      if (onUpdate) {
        ctx = pushToolExecutionContext({ onUpdate, toolName: tool.name, toolCallId });
      }

      // Gate BEFORE the process is spawned: a refused call should leave no
      // trace in `ps` and must not be able to run for even an instant.
      if (!(await passesGate(tool, params, gateConfig))) {
        if (ctx) popToolExecutionContext(ctx);
        return {
          content: [
            {
              type: 'text',
              text:
                `The \`${tool.name}\` call was not approved. This turn was started by a guest, ` +
                'so its tool calls are reviewed. Explain what you were trying to do and ask ' +
                'the owner to run it, or choose another approach.',
            },
          ],
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
        // Aborted → derive 130/143/137 from terminatedBy. Otherwise generic error → 1.
        exitToolProcess(process.tracked, process.tracked?.record.abort.signal.aborted ? null : 1);
        throw err;
      } finally {
        // Pop execution context
        if (ctx) {
          popToolExecutionContext(ctx);
        }
        process.tracked?.unsubscribeKill();
      }
    },
  };
}

/**
 * Wrap multiple legacy ToolDefinitions as pi-compatible AgentTools.
 */
export function adaptTools(
  tools: ToolDefinition[],
  pmConfig?: ToolAdapterProcessConfig,
  secretsConfig?: ToolAdapterSecretsConfig,
  gateConfig?: ToolAdapterGateConfig
): AgentTool<any>[] {
  return tools.map((t) => adaptTool(t, pmConfig, secretsConfig, gateConfig));
}

/**
 * Extract the principal string argument from a tool's params for
 * display in `argv`. Tries a small ordered list of well-known
 * field names common to the agent's tool surface, then falls back
 * to the first non-empty string value. Returns `[]` if nothing
 * suitable is found (the tool name alone is enough for `ps`).
 *
 * The returned array is appended to argv after the tool name —
 * the `ps` formatter shell-quotes any element containing
 * whitespace, so `bash "date && sleep 90 && date"` renders
 * correctly without us needing to embed quotes here.
 */
export function extractToolArg(params: unknown): string[] {
  if (typeof params !== 'object' || params === null) return [];
  // biome-ignore lint/plugin: same per-tool argument bag; this probes a few well-known field names across every tool.
  const obj = params as Record<string, unknown>;
  // Ordered by specificity — we prefer the field most uniquely
  // identifying the tool's invocation. `command` (bash),
  // `file_path` / `path` (file ops), `pattern` (search), `url`
  // (fetch), `key` (memory), …
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
  // Generic fallback — first non-empty string value.
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length > 0) return [v];
  }
  return [];
}
