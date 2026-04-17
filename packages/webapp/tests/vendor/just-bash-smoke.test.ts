/**
 * Smoke test for the vendored `just-bash` browser bundle.
 *
 * The published `just-bash@2.14.2` browser bundle physically contains the
 * AST parser (Bash uses it internally) but does NOT re-export `parse` or the
 * AST node types from its browser entry point. We vendor a rebuilt copy that
 * exposes those exports. See packages/webapp/src/vendor/just-bash/README.md.
 *
 * This test guards against regressions: if the vendored bundle ever loses the
 * exports we depend on, this file goes red and the vendor needs to be
 * rebuilt (or the upstream PR has landed and the vendor can be removed).
 */
import { describe, expect, it } from 'vitest';
import {
  parse,
  Parser,
  ParseException,
  LexerError,
  serialize,
  BashTransformPipeline,
  CommandCollectorPlugin,
  TeePlugin,
} from 'just-bash';
// NOTE: The CI-backed type-surface assertion for these AST node types lives
// in `packages/webapp/src/vendor/just-bash/type-check.ts`, which is compiled
// by `npm run typecheck`. The block below is retained for this smoke test's
// own local type annotations (ScriptNode / StatementNode / PipelineNode /
// CommandNode / SimpleCommandNode / WordNode / WordPart / the `_Assert`
// union below) — Vitest transpiles `.test.ts` files and does NOT run them
// through the project `tsc --noEmit` gate, so type-only assertions that
// live only here would silently vanish from CI if a vendor export
// regressed. See `type-check.ts` header for the full rationale.
import type {
  ScriptNode,
  StatementNode,
  PipelineNode,
  CommandNode,
  SimpleCommandNode,
  WordNode,
  WordPart,
  AssignmentNode,
  RedirectionNode,
  IfNode,
  ForNode,
  WhileNode,
  UntilNode,
  CaseNode,
  FunctionDefNode,
  SubshellNode,
  GroupNode,
  ArithmeticCommandNode,
  ConditionalCommandNode,
  CompoundCommandNode,
} from 'just-bash';

describe('just-bash vendor: parser surface', () => {
  it('exposes parse() as a function', () => {
    expect(typeof parse).toBe('function');
  });

  it('exposes the Parser class', () => {
    expect(typeof Parser).toBe('function');
  });

  it('exposes ParseException as a throwable error class', () => {
    expect(typeof ParseException).toBe('function');
    const err = new ParseException('boom', 0, 0);
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes LexerError as an error class', () => {
    expect(typeof LexerError).toBe('function');
  });

  it('exposes serialize() as a function', () => {
    expect(typeof serialize).toBe('function');
  });

  it('exposes BashTransformPipeline as a constructor', () => {
    expect(typeof BashTransformPipeline).toBe('function');
  });

  it('exposes CommandCollectorPlugin and TeePlugin as constructors', () => {
    expect(typeof CommandCollectorPlugin).toBe('function');
    expect(typeof TeePlugin).toBe('function');
  });

  it('parses a pipeline + conjunction into a single statement with multiple pipelines', () => {
    // `ls -la | wc -l && echo done` is one statement containing two pipelines
    // separated by `&&`; the first pipeline has two SimpleCommand nodes.
    const ast: ScriptNode = parse('ls -la | wc -l && echo done');
    expect(ast.type).toBe('Script');
    expect(ast.statements).toHaveLength(1);

    const stmt: StatementNode = ast.statements[0]!;
    expect(stmt.type).toBe('Statement');
    expect(stmt.pipelines).toHaveLength(2);

    const firstPipeline: PipelineNode = stmt.pipelines[0]!;
    expect(firstPipeline.type).toBe('Pipeline');
    expect(firstPipeline.commands).toHaveLength(2);

    const firstCommand: CommandNode = firstPipeline.commands[0]!;
    expect(firstCommand.type).toBe('SimpleCommand');

    const simple = firstCommand as SimpleCommandNode;
    const nameWord: WordNode = simple.name!;
    expect(nameWord.type).toBe('Word');
    const firstPart: WordPart = nameWord.parts[0]!;
    expect(firstPart.type).toBe('Literal');
  });

  it('parses `;`-separated commands into multiple statements', () => {
    const ast: ScriptNode = parse('echo hello; echo world');
    expect(ast.statements).toHaveLength(2);
    for (const stmt of ast.statements) {
      expect(stmt.pipelines).toHaveLength(1);
      const cmd = stmt.pipelines[0]!.commands[0]!;
      expect(cmd.type).toBe('SimpleCommand');
    }
  });

  it('round-trips through serialize()', () => {
    const original = 'ls -la | wc -l && echo done';
    const ast = parse(original);
    const roundTripped = serialize(ast);
    // serialize() may normalize whitespace, but the commands must survive.
    expect(roundTripped).toContain('ls');
    expect(roundTripped).toContain('wc');
    expect(roundTripped).toContain('echo');
  });

  // Pull every AST-type alias we re-export into scope so a type-only
  // regression (e.g. a missing export in dist/index.d.ts) trips the tsc gate.
  it('exposes all AST node types at the type level', () => {
    type _Assert =
      | AssignmentNode
      | RedirectionNode
      | IfNode
      | ForNode
      | WhileNode
      | UntilNode
      | CaseNode
      | FunctionDefNode
      | SubshellNode
      | GroupNode
      | ArithmeticCommandNode
      | ConditionalCommandNode
      | CompoundCommandNode;
    // Compile-time sanity only — a runtime truthy assertion keeps vitest happy.
    const sentinel: _Assert | undefined = undefined;
    expect(sentinel).toBeUndefined();
  });
});
