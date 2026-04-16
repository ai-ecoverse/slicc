/**
 * Tests for `wrapBashToolWithAllowlist` — the bash-tool wrapper that enforces
 * a command allow-list inside a spawned `agent` scoop.
 *
 * The wrapper takes an existing `AgentTool` (the bash tool) and an array of
 * allowed command heads. It returns either:
 *  - the original tool (passthrough) when the list contains the `*` wildcard, OR
 *  - a new `AgentTool` that parses each command invocation, splits it into
 *    pipeline segments on `|`, `&&`, `||`, and `;` (respecting quoted strings),
 *    extracts the first token (head) of each segment, and rejects the entire
 *    invocation atomically if any head is not on the allow-list OR if the
 *    command contains subshell syntax (`$(...)`, backticks, grouped `(cmd)`).
 *
 * Rejection returns a tool-result with `details.isError: true` — it does NOT
 * throw. This is critical so the scoop's agent loop can continue making tool
 * calls after a rejection.
 *
 * These tests cover every VAL-ALLOW-* assertion plus the feature-description
 * requirements (duplicates tolerated, `--` sentinel, redirections, whitespace
 * variations, atomicity, and the scoop-recovers-after-rejection behavior).
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { wrapBashToolWithAllowlist } from '../../src/tools/bash-tool-allowlist.js';

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Construct a bash-like AgentTool whose `execute` records its invocations and
 * returns a successful result by default. Individual tests override the
 * return value or simply assert over the recorded call log.
 */
function makeBashTool(): AgentTool<any, any> & {
  _calls: Array<{ toolCallId: string; command: string }>;
} {
  const calls: Array<{ toolCallId: string; command: string }> = [];
  const execute = vi.fn(
    async (toolCallId: string, params: Record<string, any>): Promise<AgentToolResult<any>> => {
      calls.push({ toolCallId, command: String(params['command'] ?? '') });
      return {
        content: [{ type: 'text', text: `ran: ${params['command']}` }],
        details: { isError: false },
      };
    }
  );

  const tool: AgentTool<any, any> & {
    _calls: typeof calls;
  } = {
    name: 'bash',
    label: 'bash',
    description: 'Execute a bash command.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute.' },
      },
      required: ['command'],
    } as any,
    execute,
    _calls: calls,
  };

  return tool;
}

function resultText(result: AgentToolResult<any>): string {
  return (result.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

function isErrorResult(result: AgentToolResult<any>): boolean {
  return Boolean((result.details as { isError?: boolean } | undefined)?.isError);
}

async function run(
  tool: AgentTool<any, any>,
  command: string,
  toolCallId = 'call-1'
): Promise<AgentToolResult<any>> {
  return tool.execute(toolCallId, { command } as any);
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('wrapBashToolWithAllowlist', () => {
  // ── VAL-ALLOW-001 / VAL-ALLOW-020 — Wildcard passthrough ───────────

  it('returns the original tool unchanged when allowedCommands contains "*"', () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['*']);
    expect(wrapped).toBe(bash);
  });

  it('wildcard * also acts as passthrough when mixed with other entries', () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', '*', 'wc']);
    expect(wrapped).toBe(bash);
  });

  it('wildcard passthrough permits subshell syntax', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['*']);
    const result = await run(wrapped, 'ls $(whoami)');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
    expect(bash._calls[0].command).toBe('ls $(whoami)');
  });

  // ── VAL-ALLOW-002 — single-entry allow passes through ────────────

  it('single-entry allow list permits the matching command head', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
    expect(bash._calls[0].command).toBe('ls');
  });

  // ── VAL-ALLOW-003 / VAL-ALLOW-021 — disallowed command rejected ──

  it('rejects disallowed command with an error referencing the offending command', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'curl http://x');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
    const text = resultText(result);
    expect(text).toContain('curl');
    expect(text.toLowerCase()).toMatch(/not allowed|not in allow-list|not permitted/);
  });

  it('rejection is returned as a tool-result, not a thrown exception', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    await expect(run(wrapped, 'curl http://x')).resolves.toBeTruthy();
  });

  // ── VAL-ALLOW-004 — rejection does not crash the scoop ───────────

  it('allows subsequent invocations after a rejection', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const rejected = await run(wrapped, 'curl http://x', 'call-1');
    expect(isErrorResult(rejected)).toBe(true);

    const ok = await run(wrapped, 'ls /tmp', 'call-2');
    expect(isErrorResult(ok)).toBe(false);
    expect(bash._calls.map((c) => c.command)).toEqual(['ls /tmp']);
  });

  // ── VAL-ALLOW-005 / VAL-ALLOW-006 — pipelines ────────────────────

  it('pipeline passes when every segment head is allowed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'wc']);
    const result = await run(wrapped, 'ls | wc');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('pipeline rejects when any segment head is disallowed, naming the offender', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls | wc');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('wc');
    expect(bash._calls).toHaveLength(0);
  });

  // ── VAL-ALLOW-007 / VAL-ALLOW-008 / VAL-ALLOW-009 — conjunctions and sequences ──

  it('&& conjunction segments each checked', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['true']);
    const result = await run(wrapped, 'true && echo hi');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('echo');
    expect(bash._calls).toHaveLength(0);
  });

  it('|| disjunction segments each checked', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['true']);
    const result = await run(wrapped, 'true || echo hi');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('echo');
    expect(bash._calls).toHaveLength(0);
  });

  it('; sequence segments each checked', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ; rm -rf /');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('rm');
    expect(bash._calls).toHaveLength(0);
  });

  // ── VAL-ALLOW-010 / VAL-ALLOW-011 / VAL-ALLOW-022 — subshell rejection ──

  it('rejects $(...) subshell syntax even when the inner command would be allowed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'whoami']);
    const result = await run(wrapped, 'ls $(whoami)');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects backtick subshells', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'whoami']);
    const result = await run(wrapped, 'ls `whoami`');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects grouped (cmd) subshell form', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '(ls)');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects grouped subshell mid-pipeline', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'wc']);
    const result = await run(wrapped, 'ls | (wc)');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  // ── VAL-ALLOW-012 — eval treated as a command head ───────────────

  it('treats eval as an ordinary command head (rejected if not on the allow-list)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, "eval 'ls -la'");
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('eval');
    expect(bash._calls).toHaveLength(0);
  });

  it('allows eval if explicitly on the allow-list', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['eval']);
    const result = await run(wrapped, 'eval foo');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  // ── VAL-ALLOW-013 — head matching only uses first token ──────────

  it('only the first token (head) is matched against the allow-list', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls -la /tmp');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('quoted arguments after the head do not affect head detection', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, 'echo "hello world | not a pipe"');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('does not split on operators that appear inside quoted strings', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, "echo 'a && b || c; d | e'");
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  // ── `--` sentinel — head detection unaffected ─────────────────────

  it('`--` sentinel within args does not break head detection', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls -- --hidden-file');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  // ── VAL-ALLOW-014 — whitespace variations ────────────────────────

  it('whitespace variations in the command invocation all produce the same result', async () => {
    // These invocations all have `ls` as the head and should all pass with
    // allow-list=['ls'].
    const variants = ['ls', '  ls', 'ls   ', '  ls  ', '\tls\t'];
    for (const cmd of variants) {
      const bash = makeBashTool();
      const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
      const result = await run(wrapped, cmd);
      expect(isErrorResult(result), `variant=${JSON.stringify(cmd)}`).toBe(false);
      expect(bash._calls).toHaveLength(1);
    }
  });

  it('pipeline with varied whitespace around the separator still resolves each head', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'wc']);
    for (const cmd of ['ls|wc', 'ls | wc', 'ls  |  wc', '\tls\t|\twc']) {
      const r = await run(wrapped, cmd);
      expect(isErrorResult(r), `variant=${JSON.stringify(cmd)}`).toBe(false);
    }
    expect(bash._calls).toHaveLength(4);
  });

  // ── VAL-ALLOW-015 — empty allow-list rejects everything ──────────

  it('empty allow-list rejects every command', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, []);
    for (const cmd of ['ls', 'echo hi', 'cat /etc/passwd']) {
      const r = await run(wrapped, cmd);
      expect(isErrorResult(r), `cmd=${cmd}`).toBe(true);
    }
    expect(bash._calls).toHaveLength(0);
  });

  // ── VAL-ALLOW-016 — atomic rejection: partial run is impossible ──

  it('rejects the entire invocation atomically when one segment is disallowed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls; curl evil');
    expect(isErrorResult(result)).toBe(true);
    // Neither `ls` NOR `curl` should have been forwarded to the underlying tool.
    expect(bash._calls).toHaveLength(0);
  });

  // ── VAL-ALLOW-017 — redirections do not bypass ────────────────────

  it('redirection syntax does not bypass the allow-list for a disallowed head', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'curl http://x > /tmp/x');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('curl');
    expect(bash._calls).toHaveLength(0);
  });

  it('redirection syntax is allowed when the head is on the allow-list', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls > /tmp/x');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('2>&1 redirection does not confuse head detection', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls -la 2>&1');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('< input redirection is allowed when head is allowed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['cat']);
    const result = await run(wrapped, 'cat < /tmp/x');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  // ── VAL-ALLOW-018 — whitespace-only invocation rejected safely ────

  it('rejects whitespace-only invocations without crashing', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '   ');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects empty-string invocations', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects pipelines with an empty segment', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls |');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  // ── VAL-ALLOW-019 — enforcement on every invocation ──────────────

  it('enforces on every invocation (sequence: allowed, rejected, allowed)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);

    const r1 = await run(wrapped, 'ls /home', 'call-1');
    const r2 = await run(wrapped, 'curl http://x', 'call-2');
    const r3 = await run(wrapped, 'ls /tmp', 'call-3');

    expect(isErrorResult(r1)).toBe(false);
    expect(isErrorResult(r2)).toBe(true);
    expect(isErrorResult(r3)).toBe(false);
    expect(bash._calls.map((c) => c.command)).toEqual(['ls /home', 'ls /tmp']);
  });

  // ── VAL-ALLOW-023 — case sensitivity ─────────────────────────────

  it('allow-list matching is case-sensitive', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'LS');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('LS');
    expect(bash._calls).toHaveLength(0);
  });

  // ── Duplicates tolerated ─────────────────────────────────────────

  it('duplicate allow-list entries behave like single entries', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'ls', 'wc']);
    const r1 = await run(wrapped, 'ls', 'call-1');
    const r2 = await run(wrapped, 'wc', 'call-2');
    const r3 = await run(wrapped, 'curl', 'call-3');
    expect(isErrorResult(r1)).toBe(false);
    expect(isErrorResult(r2)).toBe(false);
    expect(isErrorResult(r3)).toBe(true);
    expect(bash._calls.map((c) => c.command)).toEqual(['ls', 'wc']);
  });

  // ── Preserves AgentTool shape ────────────────────────────────────

  it('wrapped tool preserves name, label, description, and parameters', () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    expect(wrapped.name).toBe(bash.name);
    expect(wrapped.label).toBe(bash.label);
    expect(wrapped.description).toBe(bash.description);
    expect(wrapped.parameters).toBe(bash.parameters);
  });

  it('forwards toolCallId, signal, and onUpdate to the wrapped tool', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    await wrapped.execute('my-call-id', { command: 'ls /tmp' } as any, signal, onUpdate);
    expect(bash.execute).toHaveBeenCalledTimes(1);
    expect((bash.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('my-call-id');
    expect((bash.execute as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(signal);
    expect((bash.execute as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBe(onUpdate);
  });

  // ── Rejection shape is usable by the agent (tool-result channel) ──

  it('rejection result has text content so the agent sees a human message', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'curl http://x');
    const textBlocks = (result.content ?? []).filter(
      (c): c is { type: 'text'; text: string } => c.type === 'text'
    );
    expect(textBlocks.length).toBeGreaterThan(0);
    expect(textBlocks[0].text.length).toBeGreaterThan(0);
  });
});
