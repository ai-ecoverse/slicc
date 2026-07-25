#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash commands.
 * Detects `git push` and injects a verification reminder.
 *
 * Reads the tool call from stdin JSON, checks if the command starts with
 * `git push`, and emits `additionalContext` nested under `hookSpecificOutput`
 * (with `hookEventName: 'PreToolUse'`) — PreToolUse requires that nesting;
 * a top-level `additionalContext` is silently ignored by Claude Code.
 *
 * Reads by file descriptor (0), not by the `/dev/stdin` path: opening that
 * path fails with ENXIO on Linux when stdin is a pipe rather than a TTY or
 * regular file (e.g. a spawned child process fed JSON on stdin, as Claude
 * Code does and as this hook's regression test does).
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = input.tool_input?.command ?? '';

if (/^\s*git\s+push\b/.test(command)) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          'STOP: Before pushing, run the verifying-before-push skill gates. ' +
          'At minimum: npm run verify && npm run typecheck && npm run test && ' +
          'node packages/dev-tools/tools/check-touched-exemptions.mjs. ' +
          'Read the verifying-before-push skill for the full pass.',
      },
    })
  );
}
