/**
 * Tool adapter — wraps legacy ToolDefinition as pi-compatible AgentTool.
 *
 * The existing tools in packages/webapp/src/tools/ return ToolDefinition objects with a
 * simple execute(input) → ToolResult API. This adapter converts them to
 * AgentTool objects with the pi-compatible execute signature:
 *   execute(toolCallId, params, signal?, onUpdate?) → AgentToolResult
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ToolDefinition, ImageContent, TextContent } from './types.js';
import { processImageContent } from './image-processor.js';
import { createLogger } from './logger.js';
import {
  pushToolExecutionContext,
  popToolExecutionContext,
  type ToolExecutionContext,
} from '../tools/tool-ui.js';
import type { ProcessManager, ProcessOwner } from '../kernel/process-manager.js';

const log = createLogger('tool-adapter');

/** Regex to match `<img:data:image/TYPE;base64,DATA>` tags in tool result text. */
const IMG_TAG_RE = /<img:(data:(image\/[^;]+);base64,([^>]+))>/g;

/**
 * Parse a tool result string, extracting `<img:...>` tags into ImageContent blocks.
 * Sync version — extracts tags without image processing.
 */
export function parseToolResultContentRaw(text: string): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(IMG_TAG_RE)) {
    // Add any text before this match
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) {
      blocks.push({ type: 'text', text: before.trimEnd() });
    }
    // Add the image as a proper content block
    blocks.push({
      type: 'image',
      mimeType: match[2],
      data: match[3],
    });
    lastIndex = match.index! + match[0].length;
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
 * Phase 3.4 — optional process-tracking config for `adaptTool` /
 * `adaptTools`. When supplied, every tool execution registers a
 * `kind:'tool'` process whose `Process.abort` is wired to the
 * `signal` passed by the agent loop. The process exits with 0 on
 * clean return, the signal-derived code (130 SIGINT, 143 SIGTERM,
 * …) on abort, and 1 on a thrown error.
 *
 * `getParentPid` returns the parent scoop-turn pid the tool runs
 * under. `ScoopContext` provides a closure that reads the current
 * turn's pid; tests can return any pid. When the closure returns
 * `undefined`, the manager defaults `ppid` to 1 (kernel-host
 * anchor) — Phase 4's `ps -T` would show the tool as an orphan
 * but it'd still be visible.
 */
export interface ToolAdapterProcessConfig {
  processManager: ProcessManager;
  owner: ProcessOwner;
  getParentPid?: () => number | undefined;
}

/**
 * Wrap a legacy ToolDefinition as a pi-compatible AgentTool.
 */
export function adaptTool(
  tool: ToolDefinition,
  pmConfig?: ToolAdapterProcessConfig
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

      // Phase 3.4: spawn a `kind:'tool'` process. The agent's
      // `signal` is the source of truth for cancellation; we mirror
      // it onto the process via `pm.signal(pid, 'SIGINT')` so the
      // recorded `terminatedBy` and the conventional 130 exit code
      // flow back into the table when the tool throws.
      const proc = pmConfig
        ? pmConfig.processManager.spawn({
            kind: 'tool',
            argv: [tool.name],
            owner: pmConfig.owner,
            ppid: pmConfig.getParentPid?.(),
          })
        : null;
      if (proc && pmConfig && signal) {
        // Mirror the agent-loop's signal onto our process: route
        // through `pm.signal` so `terminatedBy` is recorded.
        if (signal.aborted) {
          pmConfig.processManager.signal(proc.pid, 'SIGINT');
        } else {
          signal.addEventListener(
            'abort',
            () => pmConfig.processManager.signal(proc.pid, 'SIGINT'),
            { once: true }
          );
        }
      }
      // The signal we hand to the tool's execute is the LARGER
      // union: aborts when either the agent loop or the process
      // manager signals. `proc.abort.signal` covers both because
      // the listener above forwards the upstream abort.
      const effectiveSignal = proc ? proc.abort.signal : signal;

      try {
        const result = await tool.execute(
          (params ?? {}) as Record<string, unknown>,
          effectiveSignal
        );
        let content: (TextContent | ImageContent)[];
        try {
          content = await parseToolResultContent(result.content);
        } catch (err) {
          log.warn('Image processing failed, falling back to raw content', {
            tool: tool.name,
            error: err instanceof Error ? err.message : String(err),
          });
          content = parseToolResultContentRaw(result.content);
        }
        if (proc && pmConfig) {
          pmConfig.processManager.exit(proc.pid, result.isError ? 1 : 0);
        }
        return {
          content,
          details: { isError: result.isError },
        };
      } catch (err) {
        if (proc && pmConfig) {
          // Aborted → derive 130/143/137 from terminatedBy.
          // Otherwise generic error → 1.
          pmConfig.processManager.exit(proc.pid, proc.abort.signal.aborted ? null : 1);
        }
        throw err;
      } finally {
        // Pop execution context
        if (ctx) {
          popToolExecutionContext(ctx);
        }
      }
    },
  };
}

/**
 * Wrap multiple legacy ToolDefinitions as pi-compatible AgentTools.
 */
export function adaptTools(
  tools: ToolDefinition[],
  pmConfig?: ToolAdapterProcessConfig
): AgentTool<any>[] {
  return tools.map((t) => adaptTool(t, pmConfig));
}
