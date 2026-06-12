/**
 * Bash tool — Execute shell commands via just-bash.
 *
 * Provides a single "bash" tool that runs commands and returns
 * stdout/stderr output. Uses AlmostBashShell's executeCommand() API,
 * which delegates to just-bash's Bash interpreter.
 */

import { createLogger } from '../core/logger.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import type { AlmostBashShell } from '../shell/index.js';

const log = createLogger('tool:bash');

const SEARCH_COMMAND_PREFIX =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:command\s+)?(?:grep|egrep|fgrep|rg)\b/;

/**
 * Split a command line into its top-level segments, honoring quotes and
 * escapes. Segments are separated by `;`, `|`, `&&`, and `||`; a lone `&`
 * (background) is not treated as a separator. Raw (untrimmed) segments are
 * returned, including any empty trailing segment after a final separator.
 *
 * Shared by `getLastCommandSegment` (search-output heuristic) and the
 * command-level sudo guard, which matches each non-empty segment against the
 * `Cmnd` policy.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const flush = () => {
    segments.push(current);
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      current += char;
      quote = char;
      continue;
    }

    if ((char === '&' || char === '|') && command[i + 1] === char) {
      flush();
      i++;
      continue;
    }

    if (char === ';' || char === '|') {
      flush();
      continue;
    }

    current += char;
  }

  flush();
  return segments;
}

function getLastCommandSegment(command: string): string {
  const segments = splitCommandSegments(command);
  return (segments[segments.length - 1] ?? '').trim();
}

function isExpectedNoMatchSearch(command: string, exitCode: number, stderr: string): boolean {
  if (exitCode !== 1 || stderr.trim()) return false;
  return SEARCH_COMMAND_PREFIX.test(getLastCommandSegment(command));
}

/** Create the bash tool bound to a AlmostBashShell instance. */
export function createBashTool(shell: AlmostBashShell): ToolDefinition {
  return {
    name: 'bash',
    description:
      'Execute a bash command. Full shell with pipes, redirects, chaining, control flow. ' +
      'Includes: grep, rg, sed, awk, jq, find, curl, git, node, python3, sqlite3, ' +
      'open (--view for vision), playwright-cli (browser automation). Run `commands` for full list.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute.',
        },
      },
      required: ['command'],
    },
    async execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
      const command = input['command'] as string;
      log.debug('Execute', { command });

      try {
        const result = await shell.executeCommand(command, signal);

        log.debug('Result', {
          exitCode: result.exitCode,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
        });

        let output = '';
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += result.stderr;
        if (!output) output = `(exit code: ${result.exitCode})`;

        return {
          content: output,
          isError:
            result.exitCode !== 0 &&
            !isExpectedNoMatchSearch(command, result.exitCode, result.stderr),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Error', { command, error: message });
        return { content: `Shell error: ${message}`, isError: true };
      }
    },
  };
}
