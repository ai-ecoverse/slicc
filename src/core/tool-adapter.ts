/**
 * Tool adapter — wraps legacy ToolDefinition as pi-compatible AgentTool.
 *
 * The existing tools in src/tools/ return ToolDefinition objects with a
 * simple execute(input) → ToolResult API. This adapter converts them to
 * AgentTool objects with the pi-compatible execute signature:
 *   execute(toolCallId, params, signal?, onUpdate?) → AgentToolResult
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ToolDefinition, ImageContent, TextContent } from './types.js';

/** Safety cap: truncate truly enormous single tool results that would blow the context window. */
export const MAX_SINGLE_RESULT_CHARS = 50000;

/** Regex to match `<img:data:image/TYPE;base64,DATA>` tags in tool result text. */
const IMG_TAG_RE = /<img:(data:(image\/[^;]+);base64,([^>]+))>/g;

/**
 * Parse a tool result string, extracting `<img:...>` tags into ImageContent blocks.
 * Returns an array of TextContent and ImageContent blocks suitable for the agent message.
 */
export function parseToolResultContent(text: string): (TextContent | ImageContent)[] {
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
 * Wrap a legacy ToolDefinition as a pi-compatible AgentTool.
 */
export function adaptTool(tool: ToolDefinition): AgentTool<any> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as any,
    async execute(
      _toolCallId: string,
      params: Record<string, any>,
      _signal?: AbortSignal,
      _onUpdate?: (partialResult: AgentToolResult<any>) => void,
    ): Promise<AgentToolResult<any>> {
      const result = await tool.execute(params);
      // Parse image tags FIRST — before any truncation. Image blocks (base64 data)
      // are handled natively by the API and don't consume text tokens the same way.
      // Truncating the raw string before parsing would slice mid-base64, breaking
      // image tags into garbage text that wastes the entire context window.
      const blocks = parseToolResultContent(result.content);
      // Safety cap: truncate only text blocks that exceed the limit.
      // Image blocks pass through untouched (they're sent as binary content).
      const cappedBlocks = blocks.map((block) => {
        if (block.type === 'text' && block.text && block.text.length > MAX_SINGLE_RESULT_CHARS) {
          return { ...block, text: block.text.slice(0, MAX_SINGLE_RESULT_CHARS) + '\n... (truncated — exceeded 50K char safety limit)' };
        }
        return block;
      });
      return {
        content: cappedBlocks,
        details: { isError: result.isError },
      };
    },
  };
}

/**
 * Wrap multiple legacy ToolDefinitions as pi-compatible AgentTools.
 */
export function adaptTools(tools: ToolDefinition[]): AgentTool<any>[] {
  return tools.map(adaptTool);
}
