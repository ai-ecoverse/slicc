/**
 * File tools — Read, Write, Edit operations on VirtualFS.
 *
 * Provides three tools:
 * - read_file: Read file contents
 * - write_file: Write/create a file
 * - edit_file: Apply a string replacement edit to a file
 */

import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:fs');

/** Create all file tools bound to a VirtualFS instance. */
export function createFileTools(fs: VirtualFS): ToolDefinition[] {
  return [
    createReadFileTool(fs),
    createWriteFileTool(fs),
    createEditFileTool(fs),
  ];
}

function createReadFileTool(fs: VirtualFS): ToolDefinition {
  return {
    name: 'read_file',
    description:
      'Read the contents of a file. Returns the file content as a string with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read.',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (1-based). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read. Optional.',
        },
      },
      required: ['path'],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const path = input['path'] as string;
      const offset = (input['offset'] as number | undefined) ?? 1;
      const limit = input['limit'] as number | undefined;
      log.debug('Read', { path, offset, limit });

      try {
        const content = await fs.readTextFile(path);
        const lines = content.split('\n');
        const startIdx = Math.max(0, offset - 1);
        const endIdx = limit !== undefined ? startIdx + limit : lines.length;
        const slice = lines.slice(startIdx, endIdx);

        const numbered = slice.map(
          (line, i) => `${String(startIdx + i + 1).padStart(6)} | ${line}`,
        );
        return { content: numbered.join('\n') };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Read failed', { path, error: message });
        return { content: message, isError: true };
      }
    },
  };
}

function createWriteFileTool(fs: VirtualFS): ToolDefinition {
  return {
    name: 'write_file',
    description:
      'Write content to a file. Creates the file if it does not exist, or overwrites it if it does. Parent directories are created automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const path = input['path'] as string;
      const content = input['content'] as string;
      log.debug('Write', { path, contentLength: content.length });

      try {
        await fs.writeFile(path, content);
        return { content: `File written: ${path}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Write failed', { path, error: message });
        return { content: message, isError: true };
      }
    },
  };
}

function createEditFileTool(fs: VirtualFS): ToolDefinition {
  return {
    name: 'edit_file',
    description:
      'Edit a file by replacing an exact string match. The old_string must appear exactly once in the file. Use this instead of write_file when making targeted changes to existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to edit.',
        },
        old_string: {
          type: 'string',
          description: 'The exact string to find and replace. Must be unique in the file.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement string.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const path = input['path'] as string;
      const oldString = input['old_string'] as string;
      const newString = input['new_string'] as string;
      log.debug('Edit', { path, oldLength: oldString.length, newLength: newString.length });

      try {
        const content = await fs.readTextFile(path);

        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) {
          return {
            content: `old_string not found in ${path}`,
            isError: true,
          };
        }
        if (occurrences > 1) {
          return {
            content: `old_string found ${occurrences} times in ${path}. It must be unique. Provide more context.`,
            isError: true,
          };
        }

        const newContent = content.replace(oldString, newString);
        await fs.writeFile(path, newContent);
        return { content: `File edited: ${path}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Edit failed', { path, error: message });
        return { content: message, isError: true };
      }
    },
  };
}
