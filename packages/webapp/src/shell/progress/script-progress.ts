/**
 * Script-level progress: ONE unit per tool call.
 *
 * Users ask "how long will this tool call take", not "how long will one
 * sub-step take", so the overlay reports a single fraction for the whole
 * script and folds everything below it (loop iterations, `sleep`/`timeout`
 * tickers, download bytes) into that number:
 *
 *     fraction = (completedSteps + fractionOfCurrentStep) / totalSteps
 *
 * **Steps** are registry command dispatches. Before `bash.exec` the shell hands
 * the AST (`bash.transform(script).ast` — the browser bundle exports no
 * `parse`) to `planScriptProgress`, which counts them statically:
 * `echo; echo; echo` is three ticks, `for i in {1..10}; do a; b; done` is
 * twenty, `timeout 5 cmd` is two (wrapper + inner). Interpreter builtins
 * (`cd`, `export`, `:`) never reach the registry and count zero, which is
 * exact. `&&`/`||` are counted in full — an upper bound that makes the bar lag
 * rather than lie; `end` always closes at 100%. Data-dependent shapes
 * (`while`, globs, `$var` lists, `xargs`, `if`) make the total unknown and the
 * unit indeterminate, but a determinate child (a lone `curl`, a `sleep`) still
 * drives the fraction while it runs.
 *
 * **Completion** is counted at the shell's dispatch wrapper when a command's
 * `execute` settles (just-bash's `trace` only fires for `find`, so it cannot be
 * the seam). Child units keep emitting through the same `ProgressEmitter`; the
 * emitter routes them into the active `ScriptRun` instead of the sink.
 */

import type { CommandNode, ScriptNode, StatementNode, WordNode } from 'just-bash';
import type { ProgressEmitter } from './emitter.js';
import type { ProgressEvent } from './types.js';

// just-bash's main entry exports only the top-level AST node types; derive
// the nested ones rather than deep-importing `dist/ast/types.js`.
type WordPart = WordNode['parts'][number];
type BraceItem = Extract<WordPart, { type: 'BraceExpansion' }>['items'][number];

export interface ScriptPlan {
  /** Planned registry dispatches for the whole script; null = unknown. */
  totalSteps: number | null;
}

/** Commands that dispatch ONE inner command after their own options. */
const WRAPPERS: Record<string, (args: readonly string[]) => number> = {
  // timeout [opts] DURATION cmd …
  timeout: (args) => {
    let i = 0;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '--') {
      if (['-k', '--kill-after', '-s', '--signal'].includes(args[i])) i += 1;
      i += 1;
    }
    if (args[i] === '--') i += 1;
    return i + 1; // index of the inner command name
  },
  env: (args) => {
    let i = 0;
    while (i < args.length && (args[i].startsWith('-') || args[i].includes('='))) i += 1;
    return i;
  },
  nohup: () => 0,
  nice: (args) => {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += 1;
    return i;
  },
};

/** Commands whose inner dispatch count is data-dependent. */
const UNKNOWN_COUNT = new Set(['xargs', 'watch', 'parallel', 'bash', 'sh', 'eval', 'source', '.']);

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

function partSteps(part: WordPart, known: ReadonlySet<string>): number | null {
  switch (part.type) {
    case 'CommandSubstitution':
      return scriptSteps(part.body, known);
    case 'DoubleQuoted': {
      let n = 0;
      for (const p of part.parts) {
        const inner = partSteps(p, known);
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

function wordSteps(word: WordNode, known: ReadonlySet<string>): number | null {
  let n = 0;
  for (const part of word.parts) {
    const inner = partSteps(part, known);
    if (inner === null) return null;
    n += inner;
  }
  return n;
}

/** Dispatches of a simple command: substitutions + itself (+ wrapped inner). */
function simpleSteps(
  cmd: Extract<CommandNode, { type: 'SimpleCommand' }>,
  known: ReadonlySet<string>
): number | null {
  let n = 0;
  for (const a of cmd.assignments) {
    if (!a.value) continue;
    const inner = wordSteps(a.value, known);
    if (inner === null) return null;
    n += inner;
  }
  for (const arg of cmd.args) {
    const inner = wordSteps(arg, known);
    if (inner === null) return null;
    n += inner;
  }
  if (!cmd.name) return n;
  const name = literalWord(cmd.name);
  if (name === null) return null; // $cmd — unknowable
  if (UNKNOWN_COUNT.has(name)) return null;
  if (!known.has(name)) return n; // builtin / function / typo: no registry dispatch
  n += 1;
  const wrapper = WRAPPERS[name];
  if (wrapper) {
    const argv = cmd.args.map(literalWord);
    if (argv.some((a) => a === null)) return null;
    const innerIdx = wrapper(argv as string[]);
    const inner = argv[innerIdx] as string | undefined;
    if (inner === undefined) return n; // malformed — just-bash errors out
    if (UNKNOWN_COUNT.has(inner)) return null;
    if (known.has(inner)) n += 1;
  }
  return n;
}

function rangeCount(item: Extract<BraceItem, { type: 'Range' }>): number | null {
  const start = typeof item.start === 'number' ? item.start : Number(item.start);
  const end = typeof item.end === 'number' ? item.end : Number(item.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
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

/** Iterations of a `for` word list (seq words also count their own dispatch). */
function forIterations(words: WordNode[]): number | null {
  let total = 0;
  for (const word of words) {
    const n = wordExpansions(word);
    if (n === null) return null;
    total += n;
  }
  return total;
}

function bodySteps(body: StatementNode[], known: ReadonlySet<string>): number | null {
  let n = 0;
  for (const stmt of body) {
    const inner = statementSteps(stmt, known);
    if (inner === null) return null;
    n += inner;
  }
  return n;
}

function commandSteps(cmd: CommandNode, known: ReadonlySet<string>): number | null {
  switch (cmd.type) {
    case 'SimpleCommand':
      return simpleSteps(cmd, known);
    case 'For': {
      if (!cmd.words) return null; // "$@"
      const iterations = forIterations(cmd.words);
      const body = bodySteps(cmd.body, known);
      if (iterations === null || body === null) return null;
      // `$(seq …)` words dispatch seq once, before the loop runs.
      const seqDispatches = cmd.words.filter(
        (w) => seqCount(w) !== null && known.has('seq')
      ).length;
      return seqDispatches + iterations * body;
    }
    case 'Subshell':
    case 'Group':
      return bodySteps(cmd.body, known);
    case 'FunctionDef':
      return 0; // defining dispatches nothing; calls are unknown names → 0
    default:
      return null; // if / while / until / case / (( )) / [[ ]] / C-style for
  }
}

function statementSteps(stmt: StatementNode, known: ReadonlySet<string>): number | null {
  let n = 0;
  for (const pipeline of stmt.pipelines) {
    for (const cmd of pipeline.commands) {
      const inner = commandSteps(cmd, known);
      if (inner === null) return null;
      n += inner;
    }
  }
  return n;
}

function scriptSteps(script: ScriptNode, known: ReadonlySet<string>): number | null {
  return bodySteps(script.statements, known);
}

/** Count the registry dispatches a script will make, or null when unknowable. */
export function planScriptProgress(ast: ScriptNode, known: ReadonlySet<string>): ScriptPlan {
  const total = scriptSteps(ast, known);
  return { totalSteps: total !== null && total > 0 ? total : null };
}

/** Short, single-line handle for the script (first non-empty line, capped). */
export function scriptLabel(script: string, max = 60): string {
  const line = script
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  if (!line) return 'bash';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface ChildState {
  fraction: number | undefined;
  label: string;
}

/** Live aggregator for one script execution. */
export class ScriptRun {
  readonly id: string;
  private steps = 0;
  private readonly startedAt: number;
  private finished = false;
  /** Innermost running child last; only the top drives the fraction. */
  private readonly children = new Map<string, ChildState>();

  constructor(
    private readonly plan: ScriptPlan,
    private readonly emitter: ProgressEmitter,
    private readonly label: string,
    private readonly now: () => number = Date.now
  ) {
    this.id = emitter.allocateId('script');
    this.startedAt = now();
    this.emitter.setAggregator(this);
    this.publish('start');
  }

  /** Called by the dispatch wrapper when a registry command's execute settles. */
  stepDone(): void {
    if (this.finished) return;
    this.steps += 1;
    this.publish('update');
  }

  /** Child unit events (sleep/timeout ticks, download bytes, command start/end). */
  onChild(event: ProgressEvent): void {
    if (this.finished) return;
    if (event.phase === 'end') {
      this.children.delete(event.id);
      // A finished child contributes via `stepDone`; nothing to publish here.
      return;
    }
    this.children.set(event.id, { fraction: event.fraction, label: event.label });
    if (event.fraction !== undefined || event.phase === 'start') this.publish('update');
  }

  /** Close the unit (script finished, errored or was aborted). Always 100%. */
  end(): void {
    if (this.finished) return;
    this.finished = true;
    this.emitter.setAggregator(null);
    this.emitter.emit({
      id: this.id,
      label: this.label,
      fraction: 1,
      etaMs: 0,
      done: this.steps,
      total: this.plan.totalSteps ?? undefined,
      unit: 'iterations',
      phase: 'end',
    });
  }

  /** Current overall fraction (undefined = indeterminate). */
  fraction(): number | undefined {
    const leaf = [...this.children.values()].at(-1);
    const leafFraction = leaf?.fraction;
    const total = this.plan.totalSteps;
    if (total === null) {
      // Unknown step count: a lone determinate child is the best we have.
      return leafFraction;
    }
    const partial = leafFraction ?? 0;
    return Math.min(1, (this.steps + partial) / total);
  }

  private publish(phase: 'start' | 'update'): void {
    const fraction = this.fraction();
    const elapsed = this.now() - this.startedAt;
    const etaMs =
      fraction !== undefined && fraction > 0 && fraction < 1
        ? Math.max(0, (elapsed / fraction) * (1 - fraction))
        : fraction === 1
          ? 0
          : undefined;
    const leaf = [...this.children.values()].at(-1);
    this.emitter.emit({
      id: this.id,
      label: leaf ? `${this.label} · ${leaf.label}` : this.label,
      fraction,
      etaMs,
      done: this.steps,
      total: this.plan.totalSteps ?? undefined,
      unit: 'iterations',
      phase,
    });
  }
}
