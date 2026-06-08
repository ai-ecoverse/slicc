// packages/webapp/src/scoops/structured-output-tool.ts
import type { ToolDefinition, ToolInputSchema } from '../core/types.js';

export function createStructuredOutputTool(
  schema: Record<string, unknown>,
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
