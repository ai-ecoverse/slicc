// packages/webapp/src/scoops/structured-output-tool.ts
import type { ToolDefinition, ToolInputSchema } from '../tools/types.js';

export function createStructuredOutputTool(
  // Arbitrary user-supplied JSON Schema, decoded from `agent --schema-b64` and
  // never validated on the way in — the caller,
  // `ScoopConfig.structuredOutputSchema`, is equally open. Naming a shape here
  // would assert one this value has never been checked against; it is forwarded
  // verbatim as the agent's `inputSchema`. The real fix is to validate it where
  // it is decoded, which changes behaviour and belongs in its own change.
  // biome-ignore lint/plugin: unvalidated external JSON Schema — see above.
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
