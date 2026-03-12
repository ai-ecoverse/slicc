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
import { processImageContent } from './image-processor.js';

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
export async function parseToolResultContent(text: string): Promise<(TextContent | ImageContent)[]> {
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
      return {
        content: await parseToolResultContent(result.content),
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
