/**
 * Search tools — Grep and Find/Glob on VirtualFS.
 *
 * Provides:
 * - grep: Search file contents for a pattern
 * - find: List files matching a glob-like pattern
 */

import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:search');

/** Create all search tools bound to a VirtualFS instance. */
export function createSearchTools(fs: VirtualFS): ToolDefinition[] {
  return [createGrepTool(fs), createFindTool(fs)];
}

function createGrepTool(fs: VirtualFS): ToolDefinition {
  return {
    name: 'grep',
    description:
      'Search file contents for a regular expression pattern. Searches recursively from the given directory. Returns matching lines with file paths and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to search for.',
        },
        path: {
          type: 'string',
          description: 'Directory to search in. Default: /',
        },
        include: {
          type: 'string',
          description: 'Only search files matching this glob pattern (e.g., "*.ts"). Optional.',
        },
      },
      required: ['pattern'],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const pattern = input['pattern'] as string;
      const searchPath = (input['path'] as string) ?? '/';
      const include = input['include'] as string | undefined;
      log.debug('Grep', { pattern, path: searchPath, include });

      try {
        const regex = new RegExp(pattern, 'g');
        const results: string[] = [];
        const MAX_RESULTS = 200;

        for await (const filePath of fs.walk(searchPath)) {
          if (results.length >= MAX_RESULTS) break;

          // Apply include filter
          if (include && !matchGlob(filePath, include)) continue;

          try {
            const content = await fs.readTextFile(filePath);
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              if (results.length >= MAX_RESULTS) break;
              regex.lastIndex = 0;
              if (regex.test(lines[i])) {
                results.push(`${filePath}:${i + 1}: ${lines[i]}`);
              }
            }
          } catch {
            // Skip files that can't be read (binary, etc.)
          }
        }

        log.debug('Results', { count: results.length });

        if (results.length === 0) {
          return { content: 'No matches found.' };
        }

        let output = results.join('\n');
        if (results.length >= MAX_RESULTS) {
          output += `\n... (truncated at ${MAX_RESULTS} results)`;
        }
        return { content: output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Grep error', { pattern, error: message });
        return { content: `Grep error: ${message}`, isError: true };
      }
    },
  };
}

function createFindTool(fs: VirtualFS): ToolDefinition {
  return {
    name: 'find',
    description:
      'List files and directories matching a glob pattern. Searches recursively from the given directory.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description:
            'Glob pattern to match (e.g., "*.ts", "src/**/*.js"). Default: * (all files)',
        },
        path: {
          type: 'string',
          description: 'Directory to search in. Default: /',
        },
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const pattern = (input['pattern'] as string) ?? '*';
      const searchPath = (input['path'] as string) ?? '/';
      log.debug('Find', { pattern, path: searchPath });

      try {
        const results: string[] = [];
        const MAX_RESULTS = 500;

        for await (const filePath of fs.walk(searchPath)) {
          if (results.length >= MAX_RESULTS) break;
          if (matchGlob(filePath, pattern)) {
            results.push(filePath);
          }
        }

        log.debug('Results', { count: results.length });

        if (results.length === 0) {
          return { content: 'No files found.' };
        }

        let output = results.join('\n');
        if (results.length >= MAX_RESULTS) {
          output += `\n... (truncated at ${MAX_RESULTS} results)`;
        }
        return { content: output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Find error', { pattern, error: message });
        return { content: `Find error: ${message}`, isError: true };
      }
    },
  };
}

/**
 * Simple glob matching. Supports:
 * - * matches any characters within a path segment
 * - ** matches across path segments
 * - ? matches a single character
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // If pattern doesn't start with /, treat it as matching the filename or any path suffix
  const isAbsolute = pattern.startsWith('/');

  if (!isAbsolute && !pattern.includes('/') && !pattern.includes('**')) {
    // Simple filename pattern like "*.ts"
    const fileName = filePath.split('/').pop() ?? '';
    return matchSegment(fileName, pattern);
  }

  // Convert glob to regex
  let regexStr = isAbsolute ? '^' : '(?:^|/)';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      regexStr += '.*';
      i += 2;
      if (pattern[i] === '/') i++; // skip trailing /
    } else if (pattern[i] === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (pattern[i] === '?') {
      regexStr += '[^/]';
      i++;
    } else if (pattern[i] === '.') {
      regexStr += '\\.';
      i++;
    } else {
      regexStr += pattern[i];
      i++;
    }
  }
  regexStr += '$';

  try {
    return new RegExp(regexStr).test(filePath);
  } catch {
    return false;
  }
}

function matchSegment(str: string, pattern: string): boolean {
  let regexStr = '^';
  for (const ch of pattern) {
    if (ch === '*') regexStr += '.*';
    else if (ch === '?') regexStr += '.';
    else if (ch === '.') regexStr += '\\.';
    else regexStr += ch;
  }
  regexStr += '$';

  try {
    return new RegExp(regexStr).test(str);
  } catch {
    return false;
  }
}
