/**
 * Vendor type-surface anchor for `just-bash`.
 *
 * This file exists SOLELY to pin the vendored `just-bash` type surface into
 * the `npm run typecheck` CI gate. The repo's three tsconfig entry points
 * (`tsconfig.json`, `tsconfig.cli.json`, `tsconfig.worker.json`) only include
 * `packages/<pkg>/src/<nested>.ts` globs — they deliberately exclude the
 * `packages/<pkg>/tests/` trees. That means compile-time assertions that
 * live only in a `.test.ts` file are transpiled away by Vitest at runtime
 * and never exercised by `tsc --noEmit`.
 *
 * If the vendored `just-bash` bundle ever loses a type-only export we depend
 * on (for example, if a future upstream release drops `WordPart` or renames
 * `ParameterOperation`), a test-only `import type { … }` block would still
 * compile under Vitest's transpile-only mode but would silently vanish from
 * CI. Living under a `src/` source path guarantees this file is compiled by
 * all three tsconfigs — which means any type-export regression fails
 * `npm run typecheck` and blocks merge.
 *
 * See:
 *  - `.factory/skills/upstream-integration-worker/SKILL.md` — canonical
 *    rationale for putting vendor type-surface anchors in a `tsc`-included
 *    source file rather than a test file.
 *  - `packages/webapp/src/vendor/just-bash/README.md` — overall vendor
 *    provenance + removal plan.
 *  - `packages/webapp/tests/vendor/just-bash-smoke.test.ts` — the companion
 *    RUNTIME smoke test that guards value exports via Vitest assertions.
 */

// Type-only re-exports from the vendored `just-bash` top-level entry. Every
// name here is consumed either directly by `bash-tool-allowlist.ts` in
// `packages/webapp/src/tools/` or kept in reserve for future allow-list /
// transform wrappers that walk the same AST shapes.
import type {
  ArithmeticCommandNode,
  AssignmentNode,
  CaseNode,
  CommandNode,
  CompoundCommandNode,
  ConditionalCommandNode,
  ForNode,
  FunctionDefNode,
  GroupNode,
  IfNode,
  PipelineNode,
  RedirectionNode,
  ScriptNode,
  SimpleCommandNode,
  StatementNode,
  SubshellNode,
  UntilNode,
  WhileNode,
  WordNode,
  WordPart,
} from 'just-bash';

// Value imports — `parse` and `Parser` are the only runtime entry points
// exposed by the vendor that the allow-list wrapper actually calls. Keeping
// them as real value imports (not `import type`) forces TypeScript to verify
// they exist on the vendor's bundle-level surface — if the vendor ever
// stops re-exporting either of them, this line breaks the typecheck gate.
import { parse, Parser } from 'just-bash';

// Sub-AST types that are NOT re-exported from the vendor's top-level
// `browser.d.ts` / `index.d.ts` but live on the `dist/ast/types.js` module.
// The allow-list wrapper reaches into this path for exhaustive pattern
// matching over `ParameterExpansion` / `BraceExpansion` / arithmetic
// sub-trees. Anchoring them here ensures a future upstream refactor that
// renames or removes any of these symbols fails CI instead of silently
// drifting out from under the wrapper's type assertions.
import type {
  ArithExpr,
  ArithmeticExpressionNode,
  BraceExpansionPart,
  InnerParameterOperation,
  ParameterExpansionPart,
  ParameterOperation,
} from './dist/ast/types.js';

/**
 * Union of every type the vendor exposes that the wrapper (or a future
 * wrapper) relies on. Exporting it as a single aliased union keeps every
 * member referenced — TypeScript's `--isolatedModules` will still preserve
 * unused `import type` names as long as they appear in an exported
 * declaration. Removing any imported type from this union would defeat the
 * purpose of this file.
 */
export type VendorJustBashTypeSurface =
  // Top-level AST shapes (re-exported from `just-bash`).
  | ArithmeticCommandNode
  | AssignmentNode
  | CaseNode
  | CommandNode
  | CompoundCommandNode
  | ConditionalCommandNode
  | ForNode
  | FunctionDefNode
  | GroupNode
  | IfNode
  | PipelineNode
  | RedirectionNode
  | ScriptNode
  | SimpleCommandNode
  | StatementNode
  | SubshellNode
  | UntilNode
  | WhileNode
  | WordNode
  | WordPart
  // Sub-AST shapes from the vendored `dist/ast/types.js` module.
  | ArithExpr
  | ArithmeticExpressionNode
  | BraceExpansionPart
  | InnerParameterOperation
  | ParameterExpansionPart
  | ParameterOperation;

/**
 * Frozen `const` whose property types reference the `parse` and `Parser`
 * VALUE exports via `typeof`. This pins both identifiers in the CI-backed
 * typecheck: if the vendor ever drops the value export, these `typeof`
 * references become `any` (or the module-resolution error surfaces), and
 * `npm run typecheck` fails. The object is also a live runtime reference,
 * which prevents the value imports from being elided as unused.
 */
export const vendorJustBashValueSurface: {
  readonly parse: typeof parse;
  readonly Parser: typeof Parser;
} = {
  parse,
  Parser,
};
