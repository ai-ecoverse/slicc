// packages/webapp/src/scoops/structured-output-tool.ts
import type { ToolDefinition, ToolInputSchema } from '../tools/types.js';

/**
 * A JSON Schema object describing the structured-output tool's accepted
 * arguments. It is arbitrary user-supplied JSON Schema (e.g. decoded from the
 * `agent --schema-b64` flag), so its members are open; the tool forwards it
 * verbatim as the `inputSchema` the agent must satisfy.
 */
export interface StructuredOutputSchema {
  [key: string]: unknown;
}

export function createStructuredOutputTool(
  schema: StructuredOutputSchema,
  onCapture: (v: unknown) => void
): ToolDefinition {
  return {
    name: 'StructuredOutput',
    description:
      'Return your final result. Call this exactly once, as your last action. Your arguments ARE the return value and must match the required schema.',
    inputSchema: schema as ToolInputSchema,
    async execute(input) {
      onCapture(input);
      return { content: 'Result recorded.' };
    },
  };
}
