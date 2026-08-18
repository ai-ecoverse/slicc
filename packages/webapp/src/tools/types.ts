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
 * The schema-validated argument bag a tool's `execute` receives. Its concrete
 * fields are declared per tool by that tool's `inputSchema`; at this contract
 * boundary the payload is the raw arguments the model produced (validated only
 * structurally), so each tool narrows the fields it declared.
 */
export interface ToolInput {
  [field: string]: unknown;
}

/**
 * Legacy tool definition for backwards compatibility with existing tools.
 * Used by src/tools/ factories. The tool adapter converts these to AgentTool.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: ToolInput, signal?: AbortSignal): Promise<ToolResult>;
}

/** Legacy tool result. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}
