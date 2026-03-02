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

/** Create the bash tool bound to a WasmShell instance. */
export function createBashTool(shell: WasmShell): ToolDefinition {
  return {
    name: 'bash',
    description:
      'Execute a bash command. Supports pipes (|), redirects (>, >>), chaining (&& and ;), control flow (if/else, for, while), command substitution ($(...)), shell functions, and variable expansion. Includes commands: echo, printf, pwd, cd, ls, cat, mkdir, rm, cp, mv, touch, head, tail, wc, grep, find, sed, awk, sort, uniq, tr, cut, tee, xargs, date, basename, dirname, env, export, and more.',
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
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const command = input['command'] as string;
      log.debug('Execute', { command });

      try {
        const result = await shell.executeCommand(command);

        log.debug('Result', { exitCode: result.exitCode, stdoutLength: result.stdout.length, stderrLength: result.stderr.length });

        let output = '';
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += result.stderr;
        if (!output) output = `(exit code: ${result.exitCode})`;

        return {
          content: output,
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Error', { command, error: message });
        return { content: `Shell error: ${message}`, isError: true };
      }
    },
  };
}
