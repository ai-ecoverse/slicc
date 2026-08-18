/**
 * Tool-contract types for the legacy `tools/` factories.
 *
 * These live in the `tools/` layer so tool modules import them sideways
 * (`./types.js`) instead of up-the-stack into `core/`. `core/` consumes them
 * as a legal down-edge (`core/` → `tools/`).
 */

/**
 * A single JSON Schema property descriptor — the value stored under each key of
 * an object schema's `properties` map (e.g. `{ type: 'string', description }`).
 * Only the keywords the tool factories actually emit are named; the open index
 * signature keeps the rest of the JSON Schema vocabulary (`enum`, `items`,
 * `default`, …) representable without falling back to an untyped bag.
 */
export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
  [keyword: string]: unknown;
}

/** JSON Schema for tool input parameters. */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [keyword: string]: unknown;
}

/**
 * Legacy tool definition for backwards compatibility with existing tools.
 * Used by src/tools/ factories. The tool adapter converts these to AgentTool.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  // The arguments the model produced for THIS tool, whose fields are declared by
  // that tool's own `inputSchema` and differ per tool. One shared interface here
  // could only restate "some string keys", which is what the type already says;
  // naming the real shape means making `ToolDefinition` generic over its schema,
  // a signature change across every legacy tool factory and the adapter — worth
  // doing, but not behaviour-preservingly in a debt-payoff PR.
  // biome-ignore lint/plugin: per-tool argument bag, shape declared by inputSchema.
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

/** Legacy tool result. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}
