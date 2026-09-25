/**
 * `memory_write` — registration of the one tool that writes a memory file
 * (#3157). Kept to the name, description and schema so the kernel worker's
 * boot-critical tool assembly stays small; the budget rule, the edit
 * application and the size report load from `memory-write-execute.ts` on
 * the first actual call (same split as the `edit` tool).
 */

import { MEMORY_WRITE_TOOL_NAME } from '../base/memory-budget.js';
import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolInputSchema, ToolResult } from './types.js';

export interface MemoryWriteToolDeps {
  /**
   * Session count the budget derives from (`computeBudget`), read per call
   * so a freeze that lands mid-conversation is reflected on the next write.
   */
  readSessionCount: () => Promise<number>;
  /**
   * Paths this unit probed outside its visible roots so far (#3459) — a
   * memory pass's `BlindReadLog`. A new line that records one of them as
   * absent or refuted is refused: the miss meant unknown, never absent.
   * Absent for units that see the whole workspace.
   */
  blindPaths?: () => readonly string[];
}

/**
 * Arguments for `memory_write` — the `inputSchema` is the contract. Values
 * arrive from the model, so each is checked at the boundary.
 */
export interface MemoryWriteInput {
  path?: unknown;
  content?: unknown;
  edits?: unknown;
}

const INPUT_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path of the memory file (a CLAUDE.md memory or a curation draft).',
    },
    content: {
      type: 'string',
      description: 'Complete new file content (whole-file rewrite). Exclusive with `edits`.',
    },
    edits: {
      type: 'array',
      description:
        'Exact replacements applied in order; each oldText must occur exactly once. Exclusive with `content`.',
      items: {
        type: 'object',
        required: ['oldText', 'newText'],
        properties: {
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
      },
    },
  },
  required: ['path'],
};

const DESCRIPTION =
  'Write a memory file — the only tool that may. Enforces the memory budget (over budget, a write must shrink the file) and reports the size that landed plus the remaining room or overage, so no `wc -c` turn is needed. Pass `content` for a rewrite or `edits` for exact replacements.';

export function createMemoryWriteTool(fs: VirtualFS, deps: MemoryWriteToolDeps): ToolDefinition {
  return {
    name: MEMORY_WRITE_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    async execute(input: MemoryWriteInput): Promise<ToolResult> {
      const { executeMemoryWrite } = await import('./memory-write-execute.js');
      return executeMemoryWrite(fs, deps, input);
    },
  };
}
