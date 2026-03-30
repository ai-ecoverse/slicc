/**
 * Bash tool — Execute shell commands via just-bash.
 *
 * Provides a single "bash" tool that runs commands and returns
 * stdout/stderr output. Uses WasmShell's executeCommand() API,
 * which delegates to just-bash's Bash interpreter.
 */

import type { WasmShell } from '../shell/index.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:bash');

const SEARCH_COMMAND_PREFIX =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:command\s+)?(?:grep|egrep|fgrep|rg)\b/;

function getLastCommandSegment(command: string): string {
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

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

    if (char === ';' || char === '|') {
      current = '';
      continue;
    }

    if ((char === '&' || char === '|') && command[i + 1] === char) {
      current = '';
      i++;
      continue;
    }

    current += char;
  }

  return current.trim();
}

function isExpectedNoMatchSearch(command: string, exitCode: number, stderr: string): boolean {
  if (exitCode !== 1 || stderr.trim()) return false;
  return SEARCH_COMMAND_PREFIX.test(getLastCommandSegment(command));
}

/** Create the bash tool bound to a WasmShell instance. */
export function createBashTool(shell: WasmShell): ToolDefinition {
  return {
    name: 'bash',
    description:
      'Execute a bash command in a full Unix-like shell (just-bash with 78+ commands). ' +
      'Shell features: pipes (|), redirects (>, >>, <, <<), chaining (&& ; ||), subshells, ' +
      'control flow (if/else, for, while, case), command substitution ($(...)), process substitution, ' +
      'shell functions, arrays, variable expansion, globs, brace expansion, here-docs. ' +
      'Text processing: grep, egrep, fgrep, rg (ripgrep), sed, awk, cut, tr, sort, uniq, wc, ' +
      'head, tail, fold, nl, rev, column, paste, join, comm, expand, strings, od. ' +
      'Data formats: jq (JSON), base64, md5sum, sha256sum. ' +
      'File operations: find, diff, tar, gzip, gunzip, cp, mv, rm, mkdir, touch, chmod, du, file, dirname, basename, tee, xargs, zip, unzip. ' +
      'Custom commands: git, open (serve VFS files in browser tab, --view for agent vision, --download for file save), sqlite3, node (-e shim with fs bridge), python3/python. ' +
      'Networking: curl (full HTTP client — GET, POST, PUT, DELETE with headers, data, auth). ' +
      'Utilities: seq, date, printf, expr, env, export, test/[, true, false, read.',
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
