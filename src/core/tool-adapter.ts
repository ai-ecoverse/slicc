/**
 * Tool adapter — wraps legacy ToolDefinition as pi-compatible AgentTool.
 *
 * The existing tools in src/tools/ return ToolDefinition objects with a
 * simple execute(input) → ToolResult API. This adapter converts them to
 * AgentTool objects with the pi-compatible execute signature:
 *   execute(toolCallId, params, signal?, onUpdate?) → AgentToolResult
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ToolDefinition } from './types.js';

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
        content: [{ type: 'text', text: result.content }],
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
