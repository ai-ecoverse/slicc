/** Lightweight registration boundary for Pi's VFS-backed edit tool. */

import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolInputSchema, ToolResult } from './types.js';

const log = createLogger('tool:edit');

/** Raw model arguments before Pi's compatibility preparation and validation. */
export interface EditArguments {
  path?: unknown;
  edits?: unknown;
  oldText?: unknown;
  newText?: unknown;
  [key: string]: unknown;
}

const editDescription =
  'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.';

const editSchema: ToolInputSchema = {
  type: 'object',
  required: ['path', 'edits'],
  properties: {
    path: {
      type: 'string',
      description: 'Path to the file to edit (relative or absolute)',
    },
    edits: {
      type: 'array',
      description:
        'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
      items: {
        type: 'object',
        required: ['oldText', 'newText'],
        properties: {
          oldText: {
            type: 'string',
            description:
              'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
          },
          newText: {
            type: 'string',
            description: 'Replacement text for this targeted edit.',
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
      log.debug('Edit', { path: input['path'], editCount: (input['edits'] as unknown[])?.length });
      const { executePiEdit } = await import('./pi-edit-execution.js');
      return executePiEdit(fs, cwd, input, signal);
    },
  };
}
