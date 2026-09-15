/** Lightweight registration boundary for Pi's VFS-backed edit tool. */

import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolInputSchema, ToolResult } from './types.js';

/** Raw model arguments before Pi's compatibility preparation and validation. */
export interface EditArguments {
  path?: unknown;
  edits?: unknown;
  oldText?: unknown;
  newText?: unknown;
  [key: string]: unknown;
}

const editDescription =
  'Edit one file using exact replacements. Each oldText must be unique in the original file; edits must not overlap. Combine changes to the same block in one edit.';

const editSchema: ToolInputSchema = {
  type: 'object',
  required: ['path', 'edits'],
  properties: {
    path: {
      type: 'string',
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['oldText', 'newText'],
        properties: {
          oldText: {
            type: 'string',
          },
          newText: {
            type: 'string',
          },
        },
      },
    },
  },
};

function isSingleEditInput(value: unknown): value is { oldText: string; newText: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const edit = value as EditArguments;
  return typeof edit['oldText'] === 'string' && typeof edit['newText'] === 'string';
}

/**
 * Pi validates arguments after this synchronous compatibility hook runs. Keep
 * this small mirror at registration so Pi and the VFS adapter can load on the
 * first actual edit instead of joining the worker's cold-start graph.
 */
function prepareEditArguments(input: unknown): object {
  if (!input || typeof input !== 'object') return input as object;
  const args = input as EditArguments;
  if (typeof args['edits'] === 'string') {
    try {
      const parsed: unknown = JSON.parse(args['edits']);
      if (Array.isArray(parsed)) args['edits'] = parsed;
      else if (isSingleEditInput(parsed)) args['edits'] = [parsed];
    } catch {
      // Pi leaves malformed JSON untouched for normal schema validation.
    }
  } else if (isSingleEditInput(args['edits'])) {
    args['edits'] = [args['edits']];
  }

  if (typeof args['oldText'] !== 'string' || typeof args['newText'] !== 'string') return args;
  const edits = Array.isArray(args['edits']) ? [...args['edits']] : [];
  edits.push({ oldText: args['oldText'], newText: args['newText'] });
  const { oldText: _oldText, newText: _newText, ...rest } = args;
  return { ...rest, edits };
}

/** Create Pi's public `edit` tool bound to a SLICC VFS view. */
export function createEditTool(fs: VirtualFS, cwd = '/workspace'): ToolDefinition {
  return {
    name: 'edit',
    description: editDescription,
    inputSchema: editSchema,
    prepareArguments: prepareEditArguments,
    async execute(input, signal?: AbortSignal): Promise<ToolResult> {
      const { executePiEdit } = await import('./pi-edit-execution.js');
      return executePiEdit(fs, cwd, input, signal);
    },
  };
}
