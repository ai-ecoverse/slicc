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

  // ── Subshell hardening: quoted-context and separator bypasses ────────
  //
  // Bash expands `$(...)` and backticks inside double-quoted strings but
  // NOT inside single-quoted strings. The allow-list scanner must mirror
  // that semantics so quoted-context cannot smuggle a disallowed command.

  it('rejects `$(...)` inside double-quoted arguments', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, 'echo "$(curl example.com)"');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects backticks inside double-quoted arguments', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, 'echo "`curl example.com`"');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('allows literal `$(...)` inside single-quoted arguments', async () => {
    // Single quotes disable expansion in bash: `$(...)` is just a string.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, "echo '$(curl example.com)'");
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
    expect(bash._calls[0].command).toBe("echo '$(curl example.com)'");
  });

  it('allows literal backticks inside single-quoted arguments', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, "echo '`curl example.com`'");
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('rejects bare `&` segment separator introducing a disallowed command', async () => {
    // `ls & curl evil.com` backgrounds `ls` and runs `curl` — both are
    // independent segment heads, so the allow-list check must run on each.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls & curl evil.com');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('curl');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects newline-separated invocation introducing a disallowed command', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls\ncurl evil.com');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('curl');
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

  // ── AST-backed parser tests: new cases the hand-rolled scanner could not
  //    reliably express. These rely on the just-bash parser (parse()) to
  //    classify syntax rather than manually scanning characters.

  it('parser-throws on unterminated quote → wrapper returns rejection, does NOT throw', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    // LexerError in just-bash: `"unterminated` has no matching close quote.
    await expect(run(wrapped, '"unterminated')).resolves.toBeTruthy();
    const result = await run(wrapped, '"unterminated');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('parser-throws on EOF-mid-`$(` → wrapper returns rejection', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls $(');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects non-literal head via `$CMD foo` with a message mentioning non-literal head', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '$CMD foo');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('non-literal');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects non-literal head via backtick command substitution at head position', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '`echo ls` bar');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('non-literal');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects `$(...)` at head position', async () => {
    // The AST path can identify non-literal heads produced by $(...),
    // which a substring scanner could not cleanly distinguish from the
    // general subshell-rejection path.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '$(which ls) -la');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects deeply nested substitution in quoted args', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, 'echo "$(cat $(curl x))"');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects arithmetic expansion $((...)) in args even when head is allowed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, 'echo $((1+1))');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toMatch(/arithmetic|subshell|expansion/);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects compound `if ... fi` even when inner command is allow-listed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'true']);
    const result = await run(wrapped, 'if true; then ls; fi');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects compound `while ... done` even when inner command is allow-listed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'true']);
    const result = await run(wrapped, 'while true; do ls; done');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects compound `for ... done` even when inner command is allow-listed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls', 'echo']);
    const result = await run(wrapped, 'for i in 1 2 3; do ls; done');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects braced group `{ cmd; }` even when inner command is allow-listed', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '{ ls; }');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects arithmetic command `(( ... ))`', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '(( 1 + 1 ))');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects conditional command `[[ ... ]]`', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '[[ -e /tmp ]]');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects process substitution `<(cmd)` (parse rejects it)', async () => {
    // just-bash's parser throws ParseException for process substitution;
    // the wrapper must surface that as a rejection, not a thrown error.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['cat']);
    const result = await run(wrapped, 'cat <(curl x)');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects command substitution inside a redirection target', async () => {
    // `ls > /tmp/$(whoami)` — the head `ls` is allowed, but the redirect
    // target word contains `$(...)`. AST walking of redirections[].target
    // catches this where a line-by-line scanner could not.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls > /tmp/$(whoami)');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('allows `$VAR` inside an argument when head is allow-listed', async () => {
    // Parameter expansion in args is NOT grounds for rejection (only in the
    // head); confirm args-level ParameterExpansion passes cleanly.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['echo']);
    const result = await run(wrapped, 'echo $HOME');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('allows double-quoted-with-only-literal head such as `"ls" -la`', async () => {
    // A DoubleQuoted head consisting solely of a Literal part is still a
    // literal head ("ls"). The AST walker should handle this.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, '"ls" -la');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('allows background `&` when every pipeline head is allow-listed', async () => {
    // StatementNode.background === true is not itself grounds to reject;
    // each pipeline head is still checked.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls &');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  // ── VAL-ALLOW-024 — Assignment values with command substitution ────
  //
  // just-bash parses `FOO=$(whoami) ls` as a SimpleCommand whose `name`
  // is `ls` and whose `assignments[0].value.parts` contains the
  // CommandSubstitution. The walker must iterate cmd.assignments for the
  // same reason it iterates cmd.args + cmd.redirections: pre-command
  // assignments execute before the command itself.

  it('rejects pre-command assignment with $(...) substitution (FOO=$(whoami) ls)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'FOO=$(whoami) ls');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects pre-command assignment with backtick substitution (FOO=`whoami` ls)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'FOO=`whoami` ls');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects pre-command assignment with arithmetic expansion (FOO=$((1+1)) ls)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'FOO=$((1+1)) ls');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toMatch(/arithmetic|subshell/);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects pre-command array assignment with substitution (ARR=($(whoami)) ls)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ARR=($(whoami)) ls');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects pre-command append assignment with substitution (FOO+=$(whoami) ls)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'FOO+=$(whoami) ls');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects pre-command assignment with substitution nested in double quotes (FOO="$(whoami)" ls)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'FOO="$(whoami)" ls');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects pre-command assignment with <(process-sub) — parser rejects as malformed', async () => {
    // Parser rejects `FOO=<(echo x) ls` with a ParseException. The wrapper
    // converts that into a clean rejection via the existing try/catch path.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'FOO=<(echo x) ls');
    expect(isErrorResult(result)).toBe(true);
    expect(bash._calls).toHaveLength(0);
  });

  it('allows pre-command assignments with only literal values (FOO=bar ls)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'FOO=bar ls');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('allows pre-command assignments with $VAR expansion (FOO=$BAR ls)', async () => {
    // Plain parameter expansion (no operation) is allowed in args and
    // assignment values alike — it cannot smuggle a disallowed command.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'FOO=$BAR ls');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('wildcard `*` passthrough still allows FOO=$(whoami) ls', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['*']);
    const result = await run(wrapped, 'FOO=$(whoami) ls');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  // ── VAL-ALLOW-025 — ParameterExpansion operation words with substitution ──
  //
  // The walker previously fell into `default: break;` for ParameterExpansion
  // parts, skipping nested WordNodes inside operation variants like
  // DefaultValue (${FOO:-word}), PatternRemoval (${FOO#pat}), etc. Every
  // variant that carries a WordNode must be walked.

  it('rejects ${FOO:-$(...)} DefaultValue parameter expansion with substitution', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:-$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO:=$(...)} AssignDefault parameter expansion with substitution', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:=$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO:?$(...)} ErrorIfUnset parameter expansion with substitution', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:?$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO:+$(...)} UseAlternative parameter expansion with substitution', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:+$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO#x$(...)} PatternRemoval (prefix) with substitution in pattern', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO#x$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO%x$(...)} PatternRemoval (suffix) with substitution in pattern', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO%x$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO/$(...)/x} PatternReplacement with substitution in pattern', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO/$(curl evil.com)/x}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO/x/$(...)} PatternReplacement with substitution in replacement', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO/x/$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('allows literal-only CaseModification pattern ${FOO^a} — walker does not spuriously reject', async () => {
    // Note on CaseModification: just-bash's parser treats the pattern of
    // `${VAR^pat}` / `${VAR^^pat}` / `${VAR,pat}` / `${VAR,,pat}` as a
    // literal string even when it would contain `$(...)` in real bash —
    // i.e., `${FOO^$(curl x)}` produces a Literal part, not a
    // CommandSubstitution part. That means the bypass cannot be triggered
    // through this operation in practice. The walker still recurses into
    // CaseModification.pattern as defense-in-depth (so if the parser ever
    // produces a proper nested WordNode there, the walker will catch it).
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO^a}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('rejects ${!ref:-$(...)} Indirection wrapping DefaultValue with substitution', async () => {
    // IndirectionOp wraps any InnerParameterOperation in `innerOp`. The
    // walker must recurse into innerOp and re-apply the operation switch.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${!ref:-$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO:0:$(...)} Substring length containing arithmetic command substitution', async () => {
    // Substring operations carry ArithmeticExpressionNodes, not WordNodes.
    // A minimal arith walker rejects any ArithCommandSubst inside offset
    // or length.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:0:$(cat /etc/passwd)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toMatch(/subshell|arithmetic/);
    expect(bash._calls).toHaveLength(0);
  });

  it('allows plain parameter expansion ${FOO:-default} with no substitution', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:-default}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('allows ${FOO:-$BAR} DefaultValue with only parameter expansion (no substitution)', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:-$BAR}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('allows ${FOO:1:2} Substring with literal offset and length', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:1:2}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('allows ${!ref} Indirection with no inner operation', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${!ref}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('allows ${#FOO} Length parameter expansion', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${#FOO}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('wildcard `*` passthrough still allows ${FOO:-$(curl evil.com)}', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['*']);
    const result = await run(wrapped, 'ls ${FOO:-$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  // ── VAL-ALLOW-026 — BraceExpansion items with substitution ─────────
  //
  // The walker previously fell into `default: break;` for BraceExpansion
  // parts. BraceItem of variant 'Word' carries a nested WordNode; the
  // walker must descend into it. Range items ({1..5}) only carry numbers
  // or strings — safe to skip.

  it('rejects {$(...),foo} BraceExpansion item (variant Word) with substitution', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls {$(curl evil.com),foo}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects {foo,$(...)} BraceExpansion with substitution in second item', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls {foo,$(curl evil.com)}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toContain('subshell');
    expect(bash._calls).toHaveLength(0);
  });

  it('allows {1..5} BraceExpansion Range item — safe, no nested WordNode', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls {1..5}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('allows {a,b,c} BraceExpansion with only literal items', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls {a,b,c}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('wildcard `*` passthrough still allows {$(curl evil.com),foo}', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['*']);
    const result = await run(wrapped, 'ls {$(curl evil.com),foo}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  // ── VAL-ALLOW-027 — Substring arithmetic: braced + syntax-error leaves ─
  //
  // just-bash's arithmetic parser produces two leaf-ish `ArithExpr` variants
  // that the walker previously fell through via `default: return OK`:
  //
  //   1. `ArithBracedExpansion` — shape `{ type, content: string }`. The
  //      arith parser emits this whenever it encounters a `${…}` form it
  //      cannot further parse (e.g., `${BAR:-$(whoami)}` used as a
  //      substring length). Because it carries ONLY raw content (no nested
  //      AST), there is no safe structural recursion available — the
  //      content may contain an arbitrary `$(…)` that would execute during
  //      expansion. Must be rejected outright.
  //
  //   2. `ArithSyntaxError` — shape `{ type, errorToken, message }`. Emitted
  //      for any arithmetic the parser cannot lex/parse cleanly (e.g.,
  //      `$((1 + $(whoami)))` nested as a substring length). The raw
  //      un-parsed text would still be evaluated by bash at runtime —
  //      accepting it is unsafe. Must be rejected outright.
  //
  // Live-parse evidence (recorded while writing these tests):
  //   `ls ${FOO:0:${BAR:-$(whoami)}}`
  //     → length = ArithBracedExpansion{content: 'BAR:-$(whoami)'}
  //   `ls ${FOO:${X:-$(whoami)}:2}`
  //     → offset = ArithBracedExpansion{content: 'X'}  (plus length = ArithSyntaxError)
  //   `ls ${FOO:0:$((1 + $(whoami)))}`
  //     → length = ArithSyntaxError

  it('rejects ${FOO:0:${BAR:-$(...)}} Substring length containing ArithBracedExpansion', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:0:${BAR:-$(whoami)}}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toMatch(/braced|parameter expansion|arithmetic/);
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO:${X:-$(...)}:2} Substring offset containing ArithBracedExpansion', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:${X:-$(whoami)}:2}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toMatch(
      /braced|unparseable|parameter expansion|arithmetic/
    );
    expect(bash._calls).toHaveLength(0);
  });

  it('rejects ${FOO:0:$((1 + $(whoami)))} Substring length parsed as ArithSyntaxError', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:0:$((1 + $(whoami)))}');
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result).toLowerCase()).toMatch(/unparseable|syntax|arithmetic|subshell/);
    expect(bash._calls).toHaveLength(0);
  });

  it('allows ${FOO:$((1+1)):2} Substring with well-formed ArithNested/ArithBinary', async () => {
    // Sanity control: a legitimate arithmetic expression like `1+1` parses
    // to ArithNested(ArithBinary(ArithNumber, ArithNumber)) — no substitution
    // and no leaf variants. The walker must continue to allow it.
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['ls']);
    const result = await run(wrapped, 'ls ${FOO:$((1+1)):2}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('wildcard `*` passthrough still allows ${FOO:0:${BAR:-$(whoami)}}', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['*']);
    const result = await run(wrapped, 'ls ${FOO:0:${BAR:-$(whoami)}}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('wildcard `*` passthrough still allows ${FOO:${X:-$(whoami)}:2}', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['*']);
    const result = await run(wrapped, 'ls ${FOO:${X:-$(whoami)}:2}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });

  it('wildcard `*` passthrough still allows ${FOO:0:$((1 + $(whoami)))}', async () => {
    const bash = makeBashTool();
    const wrapped = wrapBashToolWithAllowlist(bash, ['*']);
    const result = await run(wrapped, 'ls ${FOO:0:$((1 + $(whoami)))}');
    expect(isErrorResult(result)).toBe(false);
    expect(bash._calls).toHaveLength(1);
  });
});
