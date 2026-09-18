import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { createEditTool } from './edit-tool.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { verifyWriteLanded } from './write-verification.js';

const log = createLogger('tool:fs');

export interface ReadFileInput {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}

export interface WriteFileInput {
  path?: unknown;
  content?: unknown;
}

export function createFileTools(fs: VirtualFS, cwd = '/workspace'): ToolDefinition[] {
  return [createReadFileTool(fs), createWriteFileTool(fs), createEditTool(fs, cwd)];
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
