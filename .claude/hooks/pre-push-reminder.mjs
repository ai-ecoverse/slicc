#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash commands.
 * Detects `git push` and injects a verification reminder.
 *
 * Reads the tool call from stdin JSON, checks if the command
 * starts with `git push`, and emits additionalContext to stdout.
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const command = input.tool_input?.command ?? '';

if (/^\s*git\s+push\b/.test(command)) {
  console.log(
    JSON.stringify({
      additionalContext:
        'STOP: Before pushing, run the verifying-before-push skill gates. ' +
        'At minimum: npm run lint && npm run typecheck && npm run test && ' +
        'node packages/dev-tools/tools/check-touched-exemptions.mjs. ' +
        'Read the verifying-before-push skill for the full pass.',
    })
  );
}
