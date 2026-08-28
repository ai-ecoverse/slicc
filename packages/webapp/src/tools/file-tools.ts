/**
 * File tools — Read, Write, Edit operations on VirtualFS.
 *
 * Provides three tools:
 * - read_file: Read file contents (capped at pi's 2000-line / 50KB head window)
 * - write_file: Write/create a file
 * - edit_file: Apply a string replacement edit to a file
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolResult } from './types.js';

const log = createLogger('tool:fs');

/**
 * Arguments for `read_file` — its `inputSchema` is the contract. Values arrive
 * from the model, so each is cast at the boundary rather than trusted.
 */
export interface ReadFileInput {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}

/**
 * Arguments for `write_file` — its `inputSchema` is the contract. Values arrive
 * from the model, so each is cast at the boundary rather than trusted.
 */
export interface WriteFileInput {
  path?: unknown;
  content?: unknown;
}

/**
 * Arguments for `edit_file` — its `inputSchema` is the contract. Values arrive
 * from the model, so each is cast at the boundary rather than trusted.
 */
export interface EditFileInput {
  path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
}

/** Create all file tools bound to a VirtualFS instance. */
export function createFileTools(fs: VirtualFS): ToolDefinition[] {
  return [createReadFileTool(fs), createWriteFileTool(fs), createEditFileTool(fs)];
}

/**
 * Bound the read_file result to pi-coding-agent's own output-bounding contract
 * (`truncateHead` + `formatSize`) instead of returning whole files unbounded.
 * An unbounded read can dominate the whole context window and wedge compaction —
 * the same drift #2009/#2010 fixed for the bash tool. Re-using pi's `truncate`
 * module (pure string/Buffer ops, browser-safe via the vite/vitest alias) keeps
 * SLICC's read_file converged with pi's built-in `read` tool: the same 2000-line
 * / 50KB head window, the same offset-based continuation footer, and the same
 * raw (un-numbered) body — so the result is byte-for-byte pi's `read` output.
 * Text-only VFS read (vision goes through `open --view` in bash) is the one
 * intentional difference from pi's read tool.
 */
function createReadFileTool(fs: VirtualFS): ToolDefinition {
  return {
    name: 'read_file',
    description:
      `Read a file's contents. Output is capped at ${DEFAULT_MAX_LINES} lines or ` +
      `${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); use offset/limit for large files and ` +
      'the `offset=N` in the footer to page through the rest.',
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
    async execute(input: ReadFileInput): Promise<ToolResult> {
      const path = input.path as string;
      const offset = (input.offset as number | undefined) ?? 1;
      const limit = input.limit as number | undefined;
      log.debug('Read', { path, offset, limit });

      try {
        const content = await fs.readTextFile(path);
        const allLines = content.split('\n');
        const totalFileLines = allLines.length;
        const startIdx = Math.max(0, offset - 1);
        const startLineDisplay = startIdx + 1;

        if (startIdx >= allLines.length) {
          return {
            content: `Offset ${offset} is beyond end of file (${totalFileLines} lines total)`,
            isError: true,
          };
        }

        // Apply the user's offset/limit slice first, exactly like pi's read tool.
        const selectedLines =
          limit !== undefined
            ? allLines.slice(startIdx, Math.min(startIdx + limit, allLines.length))
            : allLines.slice(startIdx);
        const userLimitedLines = limit !== undefined ? selectedLines.length : undefined;

        // ALWAYS bound the slice to pi's head window, even when no limit was
        // passed (#2009). We return the RAW text with no line-number prefix, so
        // the body is byte-for-byte pi's `read` output and the cap applies to
        // exactly what the model receives. truncateHead keeps whole lines.
        const truncation = truncateHead(selectedLines.join('\n'));

        // First surviving line alone blows the byte limit: point the model at a
        // bash fallback (mirrors pi's read tool).
        if (truncation.firstLineExceedsLimit) {
          const firstLineSize = formatSize(
            new TextEncoder().encode(allLines[startIdx] ?? '').length
          );
          return {
            content:
              `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} ` +
              `limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`,
          };
        }

        // `outputLines` is a 1:1 count of file lines shown, so it drives the
        // offset-based continuation footer directly.
        const body = truncation.content;

        let footer = '';
        if (truncation.truncated) {
          const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
          const nextOffset = endLineDisplay + 1;
          footer =
            truncation.truncatedBy === 'lines'
              ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
              : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        } else if (
          userLimitedLines !== undefined &&
          startIdx + userLimitedLines < allLines.length
        ) {
          // User-specified limit stopped early but the file still has more lines.
          const remaining = allLines.length - (startIdx + userLimitedLines);
          const nextOffset = startIdx + userLimitedLines + 1;
          footer = `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
        }

        return { content: body + footer };
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
    async execute(input: WriteFileInput): Promise<ToolResult> {
      const path = input.path as string;
      const content = input.content as string;
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
    async execute(input: EditFileInput): Promise<ToolResult> {
      const path = input.path as string;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
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
