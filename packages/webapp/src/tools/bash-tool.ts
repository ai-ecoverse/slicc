/**
 * Bash tool — Execute shell commands via just-bash.
 *
 * Provides a single "bash" tool that runs commands and returns
 * stdout/stderr output. Uses AlmostBashShell's executeCommand() API,
 * which delegates to just-bash's Bash interpreter.
 */

import {
  formatSize,
  truncateTail,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import type { AlmostBashShell } from '../shell/index.js';
import type { ToolDefinition, ToolResult } from './types.js';

const log = createLogger('tool:bash');

/**
 * Cap on bash output returned to the model. An unbounded tool result can
 * dominate the whole context window and wedge compaction — a single ~482K-token
 * Signal CDP dump did exactly that in production (#2010). We re-use
 * pi-coding-agent's own output-bounding contract (`truncateTail` + `formatSize`)
 * rather than reinventing it, so SLICC's browser bash tool stays converged with
 * pi's built-in bash tool. pi's *executor* can't be reused here (it spawns an OS
 * shell via `child_process`; SLICC runs `just-bash` over the VFS in the kernel
 * worker), but its `truncate` module is pure and browser-safe (#2009).
 */
const BASH_OUTPUT_MAX_BYTES = 40 * 1024;

/**
 * Bound bash output to {@link BASH_OUTPUT_MAX_BYTES}, keeping the TAIL (errors and
 * final results live at the end), matching pi's bash convention. When truncated,
 * the full output is written to a VFS temp file and a footer tells the model
 * exactly what was dropped and how to page the rest. If the temp write fails
 * (e.g. a scoop sandbox without a writable `/tmp`), degrade to a re-run hint.
 */
async function boundBashOutput(
  output: string,
  fs: VirtualFS,
  nextSeq: () => number
): Promise<string> {
  const truncation = truncateTail(output, { maxBytes: BASH_OUTPUT_MAX_BYTES });
  if (!truncation.truncated) return output;

  const shown = `showing the last ${formatSize(truncation.outputBytes)} of ${formatSize(
    truncation.totalBytes
  )} (${truncation.totalLines} lines)`;
  const path = `/tmp/bash-output-${nextSeq()}.txt`;
  try {
    await fs.writeFile(path, output);
    return (
      `${truncation.content}\n\n[Output truncated: ${shown}. Full output written to ${path} — ` +
      `read specific ranges with \`sed -n 'START,ENDp' ${path}\`, \`tail -n +N ${path}\`, or \`grep\`.]`
    );
  } catch (err) {
    log.warn('Failed to persist full bash output', {
      error: err instanceof Error ? err.message : String(err),
    });
    return (
      `${truncation.content}\n\n[Output truncated: ${shown}. Re-run piping through ` +
      '`head`/`tail`/`grep`/`sed -n` to narrow the output.]'
    );
  }
}

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

/** Create the bash tool bound to a AlmostBashShell instance. `fs` backs the
 * temp-file paging for truncated output (writes go to `/tmp`). */
export function createBashTool(shell: AlmostBashShell, fs: VirtualFS): ToolDefinition {
  let outputSeq = 0;
  return {
    name: 'bash',
    description:
      'Execute a bash command. Full shell with pipes, redirects, chaining, control flow. ' +
      'Includes: grep, rg, sed, awk, jq, find, curl, git, node, python3, sqlite3, ' +
      'open (--view for vision), playwright-cli (browser automation). Run `commands` for full list. ' +
      `Output is capped at ${BASH_OUTPUT_MAX_BYTES / 1024}KB (the tail is kept); when truncated the ` +
      'full output is written to a /tmp file named in the result so you can page it.',
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

        const bounded = await boundBashOutput(output, fs, () => (outputSeq += 1));

        return {
          content: bounded,
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
