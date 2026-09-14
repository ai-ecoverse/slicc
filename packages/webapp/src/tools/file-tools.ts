import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import { isNoOpWriteDevicePath } from '../fs/virtual-device-paths.js';
import type { ToolDefinition, ToolResult } from './types.js';

const log = createLogger('tool:fs');

const VERIFY_FULL_READBACK_MAX_CHARS = 256 * 1024;

const VERIFY_SAMPLE_CHARS = 4096;

export interface ReadFileInput {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}

export interface WriteFileInput {
  path?: unknown;
  content?: unknown;
}

export interface EditFileInput {
  path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
}

export function createFileTools(fs: VirtualFS): ToolDefinition[] {
  return [createReadFileTool(fs), createWriteFileTool(fs), createEditFileTool(fs)];
}

async function verifyWriteLanded(
  fs: VirtualFS,
  path: string,
  content: string
): Promise<string | null> {
  if (isNoOpWriteDevicePath(normalizePath(path))) {
    return null;
  }
  try {
    const readBack = await fs.readTextFile(path);
    if (content.length <= VERIFY_FULL_READBACK_MAX_CHARS) {
      if (readBack !== content) {
        return (
          `Write did not land: ${path} content mismatch ` +
          `(expected ${content.length} chars, got ${readBack.length})`
        );
      }
      return null;
    }

    if (readBack.length !== content.length) {
      return (
        `Write did not land: ${path} content mismatch ` +
        `(expected ${content.length} chars, got ${readBack.length})`
      );
    }
    const n = VERIFY_SAMPLE_CHARS;
    if (readBack.slice(0, n) !== content.slice(0, n) || readBack.slice(-n) !== content.slice(-n)) {
      return `Write did not land: ${path} content mismatch (head/tail sample)`;
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Write did not land: ${path} is not readable (${message})`;
  }
}

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

        const selectedLines =
          limit !== undefined
            ? allLines.slice(startIdx, Math.min(startIdx + limit, allLines.length))
            : allLines.slice(startIdx);
        const userLimitedLines = limit !== undefined ? selectedLines.length : undefined;

        const truncation = truncateHead(selectedLines.join('\n'));

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
        const durabilityError = await verifyWriteLanded(fs, path, content);
        if (durabilityError) {
          log.error('Write durability check failed', { path, error: durabilityError });
          return { content: durabilityError, isError: true };
        }
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
        const durabilityError = await verifyWriteLanded(fs, path, newContent);
        if (durabilityError) {
          log.error('Edit durability check failed', { path, error: durabilityError });
          return { content: durabilityError, isError: true };
        }
        return { content: `File edited: ${path}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Edit failed', { path, error: message });
        return { content: message, isError: true };
      }
    },
  };
}
