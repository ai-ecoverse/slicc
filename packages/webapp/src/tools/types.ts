/**
 * Tool-contract types for the legacy `tools/` factories.
 *
 * These live in the `tools/` layer so tool modules import them sideways
 * (`./types.js`) instead of up-the-stack into `core/`. `core/` consumes them
 * as a legal down-edge (`core/` → `tools/`).
 */

/** JSON Schema for tool input parameters. */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/**
 * Legacy tool definition for backwards compatibility with existing tools.
 * Used by src/tools/ factories. The tool adapter converts these to AgentTool.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

/** Legacy tool result. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}
