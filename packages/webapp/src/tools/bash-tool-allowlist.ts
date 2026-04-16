/**
 * Bash-tool allow-list wrapper.
 *
 * Used by {@link ../scoops/agent-bridge.ts `AgentBridge`} to enforce a
 * per-scoop command allow-list when a caller invokes the `agent` supplemental
 * shell command with a non-wildcard `<allowed-commands>` argument.
 *
 * {@link wrapBashToolWithAllowlist} takes an existing bash `AgentTool` and an
 * array of allowed command heads (e.g. `['ls', 'wc', 'grep']`) and returns a
 * new tool that:
 *
 *  1. Passes through to the original tool UNCHANGED when the allow-list
 *     contains the `*` wildcard (wildcard allows everything, including
 *     subshell syntax — this is a conscious escape hatch).
 *  2. Otherwise, inspects every bash invocation:
 *     - Rejects commands containing subshell syntax (`$(...)`, backticks,
 *       grouped `(cmd)`) with a descriptive error naming the syntax.
 *     - Splits the command string into pipeline segments on `|`, `&&`, `||`,
 *       and `;` (respecting single/double quotes so that operators inside
 *       quoted strings are ignored).
 *     - Extracts the first whitespace-delimited token (head) of each segment.
 *     - Rejects the entire invocation atomically (no partial execution) if
 *       any segment's head is not on the allow-list, or if any segment is
 *       empty / whitespace-only.
 *
 * Rejection returns an {@link AgentToolResult} with `details.isError: true`
 * and a text message describing why — it does NOT throw. This is critical so
 * the scoop's agent loop can observe the rejection and adapt its plan
 * (see VAL-ALLOW-004 and VAL-ALLOW-021 in the mission's validation contract).
 *
 * Case-sensitive matching is intentional (see VAL-ALLOW-023): `LS` is rejected
 * when `ls` is on the allow-list.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { createLogger } from '../core/logger.js';

const log = createLogger('bash-tool-allowlist');

/** Wildcard sentinel: when present in the allow-list, the wrapper becomes a passthrough. */
const WILDCARD = '*';

/**
 * Wrap an existing bash `AgentTool` with a command allow-list enforcement layer.
 *
 * @param bashTool         The underlying bash `AgentTool` (normally produced
 *                         by `adaptTool(createBashTool(...))`).
 * @param allowedCommands  Array of command heads that are permitted. If it
 *                         contains `*`, the original tool is returned
 *                         unchanged. An empty array rejects every invocation.
 * @returns Either the original `bashTool` (wildcard) or a new `AgentTool`
 *          that rejects non-compliant invocations as tool-results.
 */
export function wrapBashToolWithAllowlist(
  bashTool: AgentTool<any, any>,
  allowedCommands: readonly string[]
): AgentTool<any, any> {
  if (allowedCommands.includes(WILDCARD)) {
    // Passthrough — wildcard allows everything, including subshells.
    return bashTool;
  }

  // Deduplicate while preserving order. Duplicates are tolerated per
  // validation contract (VAL-CMD-025).
  const allowed = new Set<string>(allowedCommands);

  const wrapped: AgentTool<any, any> = {
    name: bashTool.name,
    label: bashTool.label,
    description: bashTool.description,
    parameters: bashTool.parameters,
    prepareArguments: bashTool.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate) {
      const command = String((params as Record<string, unknown>)['command'] ?? '');

      const verdict = checkCommand(command, allowed);
      if (!verdict.ok) {
        log.debug('rejecting invocation', { command, reason: verdict.reason });
        return rejectionResult(verdict.reason);
      }

      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },
  };

  return wrapped;
}

// ─── Internals ─────────────────────────────────────────────────────────

interface Verdict {
  ok: boolean;
  reason: string;
}

/**
 * Return an object describing whether `command` is permitted by `allowed`.
 * Never throws.
 */
function checkCommand(command: string, allowed: ReadonlySet<string>): Verdict {
  // Reject entirely empty / whitespace-only invocations.
  if (command.trim().length === 0) {
    return { ok: false, reason: 'agent: empty bash invocation is not allowed' };
  }

  // Reject subshell syntax before attempting to split: subshell constructs can
  // hide disallowed heads from the allow-list. We scan the raw command string
  // while tracking quote state so that operators inside quoted strings are
  // ignored.
  const subshell = findSubshellSyntax(command);
  if (subshell) {
    return {
      ok: false,
      reason: `agent: subshell syntax not allowed (${subshell}); wildcard '*' allow-list is required to use subshells`,
    };
  }

  const segments = splitSegments(command);
  if (segments.length === 0) {
    return { ok: false, reason: 'agent: empty bash invocation is not allowed' };
  }

  for (const raw of segments) {
    const segment = raw.trim();
    if (segment.length === 0) {
      return {
        ok: false,
        reason: 'agent: empty pipeline segment is not allowed',
      };
    }

    // Defensive: a grouped subshell could survive the top-level `findSubshellSyntax`
    // scan if it somehow appeared only at a segment head (e.g. via a creative
    // operator split). Guard explicitly.
    if (segment.startsWith('(')) {
      return {
        ok: false,
        reason: `agent: subshell syntax not allowed (grouped '(cmd)'); wildcard '*' allow-list is required to use subshells`,
      };
    }

    const head = extractHead(segment);
    if (head === null || head.length === 0) {
      return {
        ok: false,
        reason: `agent: could not determine command head for segment: ${segment}`,
      };
    }

    if (!allowed.has(head)) {
      return {
        ok: false,
        reason: `agent: command '${head}' is not allowed (allow-list: ${[...allowed].sort().join(', ') || '<empty>'})`,
      };
    }
  }

  return { ok: true, reason: '' };
}

/**
 * Scan the raw command string (respecting quotes) and return a description of
 * the first subshell syntax found, or `null` if none.
 *
 * Bash semantics the scanner mirrors:
 *  - Inside **single** quotes (`'...'`), NOTHING is expanded — not `$(...)`,
 *    not backticks, not even backslash escapes. Everything between single
 *    quotes is a literal string, so we skip over it without matching.
 *  - Inside **double** quotes (`"..."`), `$(...)` and backticks ARE expanded
 *    by bash and therefore must still be flagged as subshell syntax. A
 *    backslash before `$`, `` ` ``, `"`, or `\` escapes the following char;
 *    other `\x` sequences are left literal (we defensively consume the next
 *    char after any `\` to avoid matching an escaped `$(` or `` ` ``).
 *  - Outside quotes, `$(` and backticks are always subshell syntax.
 */
function findSubshellSyntax(command: string): string | null {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote === "'") {
      // Single-quoted: raw string, no expansions, no escapes. Only the
      // matching single quote can close the string.
      if (ch === "'") quote = null;
      continue;
    }

    // Backslash escapes apply outside quotes and inside double quotes.
    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (quote === '"') {
      // Double-quoted: bash expands `$(...)` and backticks here, so we must
      // still flag them — this is the fix for the allow-list bypass where
      // `echo "$(curl evil)"` with allowedCommands=['echo'] previously
      // slipped past because the scanner skipped quoted regions wholesale.
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        return "'$(...)'";
      }
      if (ch === '`') {
        return 'backticks';
      }
      continue;
    }

    // Unquoted context.
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '$' && command[i + 1] === '(') {
      return "'$(...)'";
    }

    if (ch === '`') {
      return 'backticks';
    }
  }

  // Grouped `(cmd)` detection: outside of any quotes, look for a `(` that is
  // either (a) the first non-whitespace character, or (b) immediately follows
  // a pipeline/conjunction/sequence operator (possibly with whitespace).
  if (hasGroupedSubshell(command)) {
    return "grouped '(cmd)'";
  }

  return null;
}

/**
 * Detect a grouped subshell `(cmd)` at any segment-head position. Runs a
 * quote-aware scan and tracks the most recent "segment boundary" — which is
 * either the start of the string or an operator character (`|`, `&`, `;`).
 */
function hasGroupedSubshell(command: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let expectingHead = true;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      // Any non-whitespace inside quotes means we are no longer expecting a head.
      if (quote === null) expectingHead = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      expectingHead = false;
      continue;
    }

    if (/\s/.test(ch)) {
      continue; // Whitespace doesn't change expectingHead.
    }

    // Segment-delimiter operators: `|`, `;`, and the pair operators
    // `&&` / `||`. A bare `&` is treated as part of the surrounding token
    // (e.g. inside `2>&1`) and does NOT mark a new segment head.
    if (ch === '|' || ch === ';' || (ch === '&' && command[i + 1] === '&')) {
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      expectingHead = true;
      continue;
    }

    if (ch === '(' && expectingHead) {
      return true;
    }

    // Any other non-whitespace character means we've moved past the head.
    expectingHead = false;
  }

  return false;
}

/**
 * Split a shell command into pipeline / conjunction / sequence segments on
 * `|`, `&&`, `||`, `;`, newlines, and bare `&` (job-control), respecting
 * single and double quotes. Operators inside quoted strings are treated as
 * literal characters.
 *
 * Bare `&` subtlety: in `cmd1 & cmd2`, `&` backgrounds `cmd1` and then runs
 * `cmd2` — both segment heads must pass the allow-list. But `&` is ALSO
 * part of the redirection operators `>&`, `<&`, `N>&`, `N<&`, `>&-`, where
 * `&` immediately follows `>` or `<`. To preserve `2>&1` and friends, we
 * only treat `&` as a separator when the preceding character is NOT `>` or
 * `<`. (`&&` is handled above as a pair operator and never reaches this
 * branch.)
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }

    // Pair operators: `&&`, `||`.
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      segments.push(current);
      current = '';
      i++; // skip the paired character
      continue;
    }

    // Single-char operators: `|`, `;`, newline.
    if (ch === '|' || ch === ';' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }

    // Bare `&` (job-control / sequence): split unless it's part of a
    // redirection operator (`2>&1`, `>&2`, `<&3`, `>&-`, etc.), which we
    // identify by the directly preceding `>` or `<`.
    if (ch === '&') {
      const prev = i > 0 ? command[i - 1] : '';
      if (prev === '>' || prev === '<') {
        current += ch;
        continue;
      }
      segments.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  segments.push(current);
  return segments;
}

/**
 * Extract the first whitespace-delimited token (command head) from a trimmed
 * pipeline segment. Respects single and double quotes and `\<space>` escapes
 * so that a quoted first token is read as a unit.
 *
 * Returns `null` when the segment is empty or consists only of whitespace.
 */
function extractHead(segment: string): string | null {
  let head = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (escaped) {
      head += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      // Only escape a literal space character — match parse-shell-args behavior.
      if (segment[i + 1] === ' ') {
        head += ' ';
        i++;
        continue;
      }
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      head += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      // End of the head token.
      if (head.length > 0) return head;
      // Leading whitespace — continue scanning.
      continue;
    }

    head += ch;
  }

  return head.length > 0 ? head : null;
}

/** Build a rejection {@link AgentToolResult}. */
function rejectionResult(message: string): AgentToolResult<{ isError: true }> {
  return {
    content: [{ type: 'text', text: message }],
    details: { isError: true },
  };
}
