/**
 * Loop iteration counting for the bash progress overlay.
 *
 * We never rewrite the script. Before `bash.exec` the shell hands the AST
 * (`bash.transform(script).ast` — the browser bundle exports no `parse`) to
 * `planLoopProgress`, which looks for ONE
 * top-level `for VAR in <static list>; do …; done` whose iteration count is
 * knowable up front (literal words, brace ranges, `$(seq a b)` with literal
 * bounds). Iterations are then inferred from command dispatches: every
 * registry command flows through the shell's dispatch wrapper, which calls
 * `LoopRun.onDispatch()`; once the commands preceding the loop have been
 * dispatched, every `bodyCommandCount` further dispatches complete one
 * iteration.
 *
 * The design doc planned to count via just-bash's `trace` callback, but the
 * interpreter only traces `find` internals — it emits nothing per command —
 * so the dispatch wrapper is the counting seam instead.
 *
 * Strictly conservative: any construct whose dispatch count is not static
 * (`&&`/`||`, nested loops/ifs/functions, interpreter builtins like `cd`,
 * globs, `$@`, unknown commands, a second `for` at top level) disables
 * counting for that script — the generic start/end wrapper still covers the
 * individual commands.
 */

import type { CommandNode, ScriptNode, StatementNode, WordNode } from 'just-bash';
import type { ProgressEmitter } from './emitter.js';

// just-bash's main entry exports only the top-level AST node types; derive
// the nested ones rather than deep-importing `dist/ast/types.js`.
type ForNode = Extract<CommandNode, { type: 'For' }>;
type WordPart = WordNode['parts'][number];
type BraceItem = Extract<WordPart, { type: 'BraceExpansion' }>['items'][number];

export interface LoopPlan {
  /** Loop variable, for the label ("for f (3/12)"). */
  variable: string;
  /** Planned iteration count. */
  total: number;
  /** Registry dispatches that happen BEFORE the loop's first body command. */
  preDispatches: number;
  /** Registry dispatches per iteration. */
  bodyDispatches: number;
}

/** Count simple-command dispatches in a word's command substitutions. */
function substitutionDispatches(word: WordNode, known: ReadonlySet<string>): number | null {
  let n = 0;
  for (const part of word.parts) {
    const inner = partDispatches(part, known);
    if (inner === null) return null;
    n += inner;
  }
  return n;
}

function partDispatches(part: WordPart, known: ReadonlySet<string>): number | null {
  switch (part.type) {
    case 'CommandSubstitution':
      return scriptDispatches(part.body, known);
    case 'DoubleQuoted': {
      let n = 0;
      for (const p of part.parts) {
        const inner = partDispatches(p, known);
        if (inner === null) return null;
        n += inner;
      }
      return n;
    }
    case 'ProcessSubstitution':
      return null;
    default:
      return 0;
  }
}

/**
 * Static dispatch count of a command, or `null` when it cannot be known
 * (compound commands, functions, builtins not in the registry).
 */
function commandDispatches(cmd: CommandNode, known: ReadonlySet<string>): number | null {
  if (cmd.type !== 'SimpleCommand') return null;
  let n = 0;
  for (const a of cmd.assignments) {
    if (!a.value) continue;
    const inner = substitutionDispatches(a.value, known);
    if (inner === null) return null;
    n += inner;
  }
  if (!cmd.name) return n; // assignment-only statement: no dispatch
  const name = literalWord(cmd.name);
  if (name === null || !known.has(name)) return null;
  n += 1;
  for (const arg of cmd.args) {
    const inner = substitutionDispatches(arg, known);
    if (inner === null) return null;
    n += inner;
  }
  return n;
}

function statementDispatches(stmt: StatementNode, known: ReadonlySet<string>): number | null {
  // `&&` / `||` short-circuit, so the count is data-dependent. Background
  // statements interleave unpredictably.
  if (stmt.operators.some((op) => op !== ';') || stmt.background) return null;
  let n = 0;
  for (const pipeline of stmt.pipelines) {
    for (const cmd of pipeline.commands) {
      const inner = commandDispatches(cmd, known);
      if (inner === null) return null;
      n += inner;
    }
  }
  return n;
}

function scriptDispatches(script: ScriptNode, known: ReadonlySet<string>): number | null {
  let n = 0;
  for (const stmt of script.statements) {
    const inner = statementDispatches(stmt, known);
    if (inner === null) return null;
    n += inner;
  }
  return n;
}

/** Literal text of a word made only of literal/quoted parts, else null. */
function literalWord(word: WordNode): string | null {
  let out = '';
  for (const part of word.parts) {
    switch (part.type) {
      case 'Literal':
      case 'SingleQuoted':
      case 'Escaped':
        out += part.value;
        break;
      case 'DoubleQuoted': {
        for (const p of part.parts) {
          if (p.type !== 'Literal' && p.type !== 'Escaped') return null;
          out += p.value;
        }
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

function rangeCount(item: Extract<BraceItem, { type: 'Range' }>): number | null {
  const start = typeof item.start === 'number' ? item.start : Number(item.start);
  const end = typeof item.end === 'number' ? item.end : Number(item.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    // Character ranges {a..e}
    const s = String(item.start);
    const e = String(item.end);
    if (s.length !== 1 || e.length !== 1) return null;
    return Math.abs(e.charCodeAt(0) - s.charCodeAt(0)) + 1;
  }
  const step = Math.abs(item.step ?? 1) || 1;
  return Math.floor(Math.abs(end - start) / step) + 1;
}

/** `$(seq a b)` / `$(seq b)` / `$(seq a s b)` with literal numeric args. */
function seqCount(word: WordNode): number | null {
  if (word.parts.length !== 1 || word.parts[0].type !== 'CommandSubstitution') return null;
  const body = word.parts[0].body;
  if (body.statements.length !== 1) return null;
  const stmt = body.statements[0];
  if (stmt.pipelines.length !== 1 || stmt.pipelines[0].commands.length !== 1) return null;
  const cmd = stmt.pipelines[0].commands[0];
  if (cmd.type !== 'SimpleCommand' || !cmd.name || literalWord(cmd.name) !== 'seq') return null;
  const nums = cmd.args.map((a) => {
    const lit = literalWord(a);
    return lit === null ? Number.NaN : Number(lit);
  });
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let first = 1;
  let step = 1;
  let last: number;
  if (nums.length === 1) [last] = nums;
  else if (nums.length === 2) [first, last] = nums;
  else if (nums.length === 3) [first, step, last] = nums;
  else return null;
  if (step === 0) return null;
  const count = Math.floor((last - first) / step) + 1;
  return count > 0 ? count : 0;
}

/** Number of words a brace expansion part produces, or null when not static. */
function braceItemCount(items: readonly BraceItem[]): number | null {
  let count = 0;
  for (const item of items) {
    const n = item.type === 'Word' ? wordExpansions(item.word) : rangeCount(item);
    if (n === null) return null;
    count += n;
  }
  return count;
}

/** Number of words ONE `for` word expands to, or null when data-dependent. */
function wordExpansions(word: WordNode): number | null {
  const seq = seqCount(word);
  if (seq !== null) return seq;
  let expansions = 1;
  for (const part of word.parts) {
    switch (part.type) {
      case 'Literal':
      case 'SingleQuoted':
      case 'Escaped':
        break;
      case 'DoubleQuoted':
        if (part.parts.some((p) => p.type !== 'Literal' && p.type !== 'Escaped')) return null;
        break;
      case 'BraceExpansion': {
        const items = braceItemCount(part.items);
        if (items === null) return null;
        expansions *= items;
        break;
      }
      default:
        return null; // $var, $(cmd), globs, ~ …
    }
  }
  return expansions;
}

/** Static word count of a `for` word list, or null when data-dependent. */
function staticWordCount(words: WordNode[]): number | null {
  let total = 0;
  for (const word of words) {
    const n = wordExpansions(word);
    if (n === null) return null;
    total += n;
  }
  return total;
}

/**
 * Inspect a parsed script and return a plan when its first top-level `for`
 * loop is statically countable. Returns null (no loop progress) otherwise.
 */
export function planLoopProgress(ast: ScriptNode, known: ReadonlySet<string>): LoopPlan | null {
  let pre = 0;
  let found: LoopPlan | null = null;
  for (const stmt of ast.statements) {
    if (found) break; // statements after the loop do not matter
    const single = stmt.pipelines.length === 1 && stmt.pipelines[0].commands.length === 1;
    const only = single ? stmt.pipelines[0].commands[0] : null;
    if (only?.type === 'For') {
      if (stmt.background) return null;
      found = planFor(only, pre, known);
      if (!found) return null;
      continue;
    }
    const n = statementDispatches(stmt, known);
    if (n === null) return null;
    pre += n;
  }
  return found && found.total > 0 && found.bodyDispatches > 0 ? found : null;
}

function planFor(
  node: ForNode,
  preDispatches: number,
  known: ReadonlySet<string>
): LoopPlan | null {
  if (!node.words) return null; // "$@"
  const total = staticWordCount(node.words);
  if (total === null) return null;
  let body = 0;
  for (const stmt of node.body) {
    const n = statementDispatches(stmt, known);
    if (n === null) return null;
    body += n;
  }
  return { variable: node.variable, total, preDispatches, bodyDispatches: body };
}

/** Live counter for one script execution. */
export class LoopRun {
  private dispatches = 0;
  private done = 0;
  private readonly id: string;
  private readonly startedAt: number;
  private finished = false;

  constructor(
    private readonly plan: LoopPlan,
    private readonly emitter: ProgressEmitter,
    private readonly now: () => number = Date.now
  ) {
    this.id = emitter.allocateId('loop');
    this.startedAt = now();
    emitter.emit({
      id: this.id,
      label: this.label(),
      fraction: 0,
      done: 0,
      total: plan.total,
      unit: 'iterations',
      phase: 'start',
    });
  }

  private label(): string {
    return `for ${this.plan.variable} (${this.done}/${this.plan.total})`;
  }

  /** Called by the dispatch wrapper for every registry command. O(1). */
  onDispatch(): void {
    if (this.finished) return;
    this.dispatches += 1;
    const inLoop = this.dispatches - this.plan.preDispatches;
    if (inLoop <= 0) return;
    const iterations = Math.min(this.plan.total, Math.floor(inLoop / this.plan.bodyDispatches));
    if (iterations === this.done) return;
    this.done = iterations;
    const elapsed = this.now() - this.startedAt;
    const etaMs = this.done > 0 ? (elapsed / this.done) * (this.plan.total - this.done) : undefined;
    this.emitter.emit({
      id: this.id,
      label: this.label(),
      fraction: this.done / this.plan.total,
      etaMs,
      done: this.done,
      total: this.plan.total,
      unit: 'iterations',
      phase: 'update',
    });
  }

  /** Close the unit (script finished, errored or was aborted). */
  end(): void {
    if (this.finished) return;
    this.finished = true;
    this.emitter.emit({
      id: this.id,
      label: this.label(),
      fraction: this.done / this.plan.total,
      etaMs: 0,
      done: this.done,
      total: this.plan.total,
      unit: 'iterations',
      phase: 'end',
    });
  }
}
