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
 *  2. Otherwise, parses every bash invocation into a `just-bash` AST and:
 *     - Rejects the invocation atomically if the parser throws (unterminated
 *       quote, EOF mid-`$(`, process substitution `<(...)`, etc.).
 *     - Rejects compound commands (`(cmd)`, `{ cmd; }`, `if`, `for`, `while`,
 *       `case`, `(( ))`, `[[ ]]`, function definitions) outright — they are
 *       outside the allow-list's semantics. A wildcard `*` allow-list is
 *       required to use them.
 *     - For each simple command, extracts the literal head by walking
 *       `WordNode.parts` and joining only `Literal` / `SingleQuoted` /
 *       `Escaped` parts. If any part is `ParameterExpansion`,
 *       `CommandSubstitution`, `ArithmeticExpansion`, or
 *       `ProcessSubstitution`, the invocation is rejected because the head
 *       cannot be statically verified.
 *     - Checks the head against the allow-list (case-sensitive — see
 *       VAL-ALLOW-023).
 *     - Walks each command's `args` and each redirection's target `WordNode`
 *       (including inside double-quoted parts) and rejects the invocation if
 *       any `CommandSubstitutionPart`, `ArithmeticExpansionPart`, or
 *       `ProcessSubstitutionPart` appears at any nesting depth.
 *     - A bare `&` (background job) does NOT itself reject an invocation:
 *       `StatementNode.background === true` just marks the pipeline as
 *       backgrounded. Every pipeline head has already been allow-list-checked.
 *
 * Rejection returns an {@link AgentToolResult} with `details.isError: true`
 * and a text message describing why — it NEVER throws, even if the parser
 * raises a `ParseException` or `LexerError`. This is critical so the scoop's
 * agent loop can observe the rejection and adapt its plan (see VAL-ALLOW-004
 * and VAL-ALLOW-021 in the mission's validation contract).
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  parse,
  type CommandNode,
  type PipelineNode,
  type ScriptNode,
  type SimpleCommandNode,
  type StatementNode,
  type WordNode,
  type WordPart,
} from 'just-bash';
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

const OK: Verdict = { ok: true, reason: '' };

/**
 * Return an object describing whether `command` is permitted by `allowed`.
 * Never throws — parser exceptions are converted into rejection verdicts.
 */
function checkCommand(command: string, allowed: ReadonlySet<string>): Verdict {
  // Reject entirely empty / whitespace-only invocations early. The parser
  // would otherwise return an empty `statements` array which we'd also
  // reject, but matching the old behavior keeps the error message clear.
  if (command.trim().length === 0) {
    return { ok: false, reason: 'agent: empty bash invocation is not allowed' };
  }

  let ast: ScriptNode;
  try {
    ast = parse(command);
  } catch (err) {
    // ParseException, LexerError, or any other error from the parser means
    // the command string is not a well-formed bash script. Reject rather
    // than run an unverified command.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `agent: could not parse bash invocation (${message})`,
    };
  }

  if (ast.statements.length === 0) {
    return { ok: false, reason: 'agent: empty bash invocation is not allowed' };
  }

  for (const statement of ast.statements) {
    const verdict = checkStatement(statement, allowed);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

function checkStatement(stmt: StatementNode, allowed: ReadonlySet<string>): Verdict {
  // `StatementNode.background === true` (bare `&`) is NOT grounds to reject —
  // every pipeline head is still allow-list-checked.
  for (const pipeline of stmt.pipelines) {
    const verdict = checkPipeline(pipeline, allowed);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

function checkPipeline(pipeline: PipelineNode, allowed: ReadonlySet<string>): Verdict {
  for (const command of pipeline.commands) {
    const verdict = checkCommandNode(command, allowed);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

function checkCommandNode(command: CommandNode, allowed: ReadonlySet<string>): Verdict {
  if (command.type !== 'SimpleCommand') {
    // Compound commands include subshell `(cmd)`, group `{ cmd; }`, `if`,
    // `for`, `while`, `until`, `case`, `(( ))`, `[[ ]]`, and function
    // definitions. All are outside the allow-list's semantics because their
    // inner commands escape any single-head check.
    return {
      ok: false,
      reason: `agent: subshell syntax not allowed (${compoundLabel(command.type)}); wildcard '*' allow-list is required to use subshells and compound commands`,
    };
  }
  return checkSimpleCommand(command, allowed);
}

function compoundLabel(type: CommandNode['type']): string {
  switch (type) {
    case 'Subshell':
      return "grouped '(cmd)'";
    case 'Group':
      return "group '{ cmd; }'";
    case 'If':
      return 'if statement';
    case 'For':
    case 'CStyleFor':
      return 'for loop';
    case 'While':
      return 'while loop';
    case 'Until':
      return 'until loop';
    case 'Case':
      return 'case statement';
    case 'ArithmeticCommand':
      return "arithmetic '(( expr ))'";
    case 'ConditionalCommand':
      return "conditional '[[ expr ]]'";
    case 'FunctionDef':
      return 'function definition';
    default:
      return type;
  }
}

function checkSimpleCommand(cmd: SimpleCommandNode, allowed: ReadonlySet<string>): Verdict {
  if (cmd.name === null) {
    // Name-less SimpleCommand: e.g. `ls |` parses as pipeline with a trailing
    // SimpleCommand that has no name. Also covers assignment-only invocations.
    return { ok: false, reason: 'agent: empty pipeline segment is not allowed' };
  }

  const headResult = extractLiteralHead(cmd.name);
  if (headResult.kind === 'nonLiteral') {
    return {
      ok: false,
      reason: `agent: non-literal command head not allowed (head contains ${headResult.reason}); the allow-list requires a statically literal command name`,
    };
  }
  const head = headResult.value;
  if (head.length === 0) {
    return { ok: false, reason: 'agent: could not determine command head' };
  }

  if (!allowed.has(head)) {
    return {
      ok: false,
      reason: `agent: command '${head}' is not allowed (allow-list: ${[...allowed].sort().join(', ') || '<empty>'})`,
    };
  }

  // Walk every argument word for disallowed substitution parts.
  for (const arg of cmd.args) {
    const verdict = walkWordParts(arg.parts);
    if (!verdict.ok) return verdict;
  }

  // Walk every redirection target — its value is either a WordNode (file
  // path etc.) or a HereDocNode whose content is itself a WordNode.
  for (const redir of cmd.redirections) {
    const target = redir.target;
    if (target.type === 'Word') {
      const verdict = walkWordParts(target.parts);
      if (!verdict.ok) return verdict;
    } else if (target.type === 'HereDoc' && !target.quoted) {
      // Unquoted here-doc delimiters expand substitutions in their content;
      // only check for substitution parts in that case. A quoted delimiter
      // (<< 'EOF' etc.) disables expansion, so its content is a literal.
      const verdict = walkWordParts(target.content.parts);
      if (!verdict.ok) return verdict;
    }
  }

  return OK;
}

/**
 * Head-extraction result discriminant.
 *
 * `literal` means the head word consists solely of parts that bash treats
 * as plain text (Literal, SingleQuoted, Escaped, or a DoubleQuoted part that
 * itself wraps only literal-equivalent pieces). `nonLiteral` means the head
 * contains an expansion that cannot be statically verified (parameter,
 * command substitution, arithmetic expansion, process substitution, tilde,
 * brace, or glob) — we refuse to guess what the expanded value would be.
 */
type HeadResult = { kind: 'literal'; value: string } | { kind: 'nonLiteral'; reason: string };

function extractLiteralHead(word: WordNode): HeadResult {
  let value = '';
  for (const part of word.parts) {
    const inner = extractLiteralHeadPart(part);
    if (inner.kind === 'nonLiteral') return inner;
    value += inner.value;
  }
  return { kind: 'literal', value };
}

function extractLiteralHeadPart(part: WordPart): HeadResult {
  switch (part.type) {
    case 'Literal':
    case 'SingleQuoted':
    case 'Escaped':
      return { kind: 'literal', value: part.value };
    case 'DoubleQuoted': {
      let value = '';
      for (const inner of part.parts) {
        const r = extractLiteralHeadPart(inner);
        if (r.kind === 'nonLiteral') return r;
        value += r.value;
      }
      return { kind: 'literal', value };
    }
    case 'ParameterExpansion':
      return { kind: 'nonLiteral', reason: 'parameter expansion ($VAR or ${...})' };
    case 'CommandSubstitution':
      return {
        kind: 'nonLiteral',
        reason: part.legacy ? 'backtick command substitution' : 'command substitution $(...)',
      };
    case 'ArithmeticExpansion':
      return { kind: 'nonLiteral', reason: 'arithmetic expansion $((...))' };
    case 'ProcessSubstitution':
      return {
        kind: 'nonLiteral',
        reason:
          part.direction === 'input'
            ? 'process substitution <(...)'
            : 'process substitution >(...)',
      };
    case 'TildeExpansion':
      return { kind: 'nonLiteral', reason: 'tilde expansion (~ / ~user)' };
    case 'BraceExpansion':
      return { kind: 'nonLiteral', reason: 'brace expansion ({a,b})' };
    case 'Glob':
      return { kind: 'nonLiteral', reason: 'glob pattern' };
    default: {
      // Defensive catch-all for any future WordPart types the parser gains.
      const anyPart = part as { type: string };
      return { kind: 'nonLiteral', reason: anyPart.type };
    }
  }
}

/**
 * Walk a `WordNode`'s parts (including nested parts inside DoubleQuoted)
 * looking for disallowed substitution forms. Parameter expansion is
 * allowed in args — this mirrors bash's semantics where `$HOME` is just a
 * value and doesn't change the current command's head.
 */
function walkWordParts(parts: readonly WordPart[]): Verdict {
  for (const part of parts) {
    switch (part.type) {
      case 'CommandSubstitution':
        return {
          ok: false,
          reason: `agent: subshell syntax not allowed (${part.legacy ? 'backticks' : "'$(...)'"}); wildcard '*' allow-list is required to use subshells`,
        };
      case 'ArithmeticExpansion':
        return {
          ok: false,
          reason: `agent: subshell syntax not allowed ('$((...))' arithmetic expansion); wildcard '*' allow-list is required to use arithmetic expansions`,
        };
      case 'ProcessSubstitution':
        return {
          ok: false,
          reason: `agent: subshell syntax not allowed (${part.direction === 'input' ? "'<(...)'" : "'>(...)'"} process substitution); wildcard '*' allow-list is required to use process substitutions`,
        };
      case 'DoubleQuoted': {
        const inner = walkWordParts(part.parts);
        if (!inner.ok) return inner;
        break;
      }
      // Literal, SingleQuoted, Escaped, ParameterExpansion, TildeExpansion,
      // BraceExpansion, Glob are all allowed at the args / redirection-
      // target level. They cannot smuggle a disallowed command because the
      // resulting string is passed to the already-allow-listed head.
      default:
        break;
    }
  }
  return OK;
}

/** Build a rejection {@link AgentToolResult}. */
function rejectionResult(message: string): AgentToolResult<{ isError: true }> {
  return {
    content: [{ type: 'text', text: message }],
    details: { isError: true },
  };
}
