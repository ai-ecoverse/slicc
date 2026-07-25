// Regression test for the PreToolUse hook schema (PR #1665 review finding):
// a top-level `additionalContext` is silently ignored by Claude Code — it
// must be nested under `hookSpecificOutput` with `hookEventName: 'PreToolUse'`.
// See https://code.claude.com/docs/en/hooks.md ("Add context for Claude").
//
// Spawns the real script and feeds it stdin exactly as Claude Code does, so
// the test exercises the actual invocation contract rather than an import.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = fileURLToPath(new URL('./pre-push-reminder.mjs', import.meta.url));

/** Run the hook script with the given tool_input.command, return parsed stdout (or null). */
async function runHook(command) {
  const child = spawn(process.execPath, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(JSON.stringify({ tool_input: { command } }));
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

describe('pre-push-reminder.mjs', () => {
  it('nests additionalContext under hookSpecificOutput.hookEventName for git push', async () => {
    const output = await runHook('git push origin main');

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: expect.stringContaining('verifying-before-push'),
      },
    });
    // A top-level additionalContext is silently ignored by Claude Code — assert
    // it is absent so this can't regress back to the pre-fix shape.
    expect(output).not.toHaveProperty('additionalContext');
  });

  it('emits nothing for a non-push command', async () => {
    const output = await runHook('git status');
    expect(output).toBeNull();
  });
});
