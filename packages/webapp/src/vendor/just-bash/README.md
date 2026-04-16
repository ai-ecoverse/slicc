# Vendored `just-bash` — browser bundle with AST parser exposed

This directory is a **temporary local vendor** of [`just-bash`](https://github.com/vercel-labs/just-bash) rebuilt from source with a tiny patch that re-exports the AST parser surface from the browser entry point.

It exists solely to unblock SLICC's AST-backed bash allow-list. **Delete this directory the moment an upstream published release exposes `parse` + AST node types from `src/browser.ts`.**

## Why vendor at all?

`just-bash@2.14.2` (our current dependency) bundles the parser into `dist/bundle/browser.js` at runtime — `Bash` uses it internally — but the file `src/browser.ts` does not re-export it. The Node entry (`src/index.ts`) does export `parse`, but the Node bundle imports `node:fs` + `node:path` transitively, which Vite cannot satisfy in a browser bundle.

Rather than forking permanently or writing our own parser, we ship the rebuilt artifact locally and wire a Vite alias so `import { parse } from 'just-bash'` resolves here instead of to `node_modules/just-bash/`.

## Provenance

| Field            | Value                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| Upstream repo    | <https://github.com/vercel-labs/just-bash>                                     |
| Upstream version | `2.14.2`                                                                       |
| Upstream HEAD    | `1bfa047e0dc5881651c855049e99070076f0c839` (branch `main`, fetched 2026-04-16) |
| Upstream PR      | <https://github.com/vercel-labs/just-bash/pull/193>                            |
| Prior pattern    | [PR #186](https://github.com/vercel-labs/just-bash/pull/186) — `MountableFs`   |
| Patched files    | `src/browser.ts` (+29 lines), `src/index.ts` (+18 lines)                       |

The upstream PR URL is: <https://github.com/vercel-labs/just-bash/pull/193>.

## What the patch does

Purely additive exports in `src/browser.ts` and `src/index.ts` — no runtime code changed. All identifiers being exported were already compiled into `dist/bundle/browser.js`; the patch just re-exports them from the module's public surface.

```diff
# src/browser.ts (+29 lines)
+export type {
+  ArithmeticCommandNode,
+  AssignmentNode,
+  CaseNode,
+  CommandNode,
+  CompoundCommandNode,
+  ConditionalCommandNode,
+  ForNode,
+  FunctionDefNode,
+  GroupNode,
+  IfNode,
+  PipelineNode,
+  RedirectionNode,
+  ScriptNode,
+  SimpleCommandNode,
+  StatementNode,
+  SubshellNode,
+  UntilNode,
+  WhileNode,
+  WordNode,
+  WordPart,
+} from "./ast/types.js";
+export { LexerError } from "./parser/lexer.js";
+export { parse, Parser } from "./parser/parser.js";
+export { ParseException } from "./parser/types.js";
+export { BashTransformPipeline } from "./transform/pipeline.js";
+export { CommandCollectorPlugin } from "./transform/plugins/command-collector.js";
+export { TeePlugin } from "./transform/plugins/tee-plugin.js";
+export { serialize } from "./transform/serialize.js";

# src/index.ts (+18 lines)
#  - broaden AST type re-exports to match browser.ts
#  - add Parser, ParseException, LexerError class exports alongside parse
```

None of the newly-exposed modules transitively import from `node:fs`/`node:path`/`node:child_process` — the AST/parser/transform layers are pure TypeScript. The browser-bundle safety tests (`src/browser.bundle.test.ts`) continue to pass after rebuild.

## How to rebuild this vendor

These steps exactly reproduce the files in `dist/` inside this directory. Run them from any working machine:

```bash
# 1) Clone upstream at the HEAD recorded above
git clone https://github.com/vercel-labs/just-bash.git /tmp/just-bash-src
cd /tmp/just-bash-src
git checkout 1bfa047e0dc5881651c855049e99070076f0c839

# 2) Apply the patch documented in the "What the patch does" section
#    (edit src/browser.ts and src/index.ts by hand, or cherry-pick the
#    commit from our upstream PR once it exists)

# 3) Build upstream with its own tooling
pnpm install --ignore-scripts --no-frozen-lockfile
pnpm build

# 4) Re-copy the artifacts we actually use back into this vendor dir
SLICC=/path/to/slicc/repo
VENDOR="$SLICC/packages/webapp/src/vendor/just-bash"
cp /tmp/just-bash-src/dist/bundle/browser.js "$VENDOR/dist/bundle/browser.js"
cp /tmp/just-bash-src/dist/browser.d.ts       "$VENDOR/dist/browser.d.ts"
cp /tmp/just-bash-src/dist/index.d.ts         "$VENDOR/dist/index.d.ts"
cp /tmp/just-bash-src/dist/index.d.cts        "$VENDOR/dist/index.d.cts"

# 5) If any new transitive .d.ts files appeared upstream, copy those too.
#    Our vendor tracks the same subdirectory layout as upstream's published
#    npm package; we deliberately skip cli/, comparison-tests/, spec-tests/,
#    test-utils/, shared/, security/fuzzing/, and shell/ because they are
#    not referenced from index.d.ts or browser.d.ts.
```

## How this vendor is wired

- `packages/webapp/vite.config.ts` aliases `'just-bash'` → `src/vendor/just-bash/dist/bundle/browser.js`
- `packages/chrome-extension/vite.config.ts` mirrors the alias (via relative path) so extension builds see the same patched bundle
- `vitest.config.ts` applies the same alias so tests resolve the vendor
- `tsconfig.json` adds a `paths` entry so TypeScript resolves `import type ... from 'just-bash'` to `src/vendor/just-bash/dist/index.d.ts`
- The vendor directory also ships a local `package.json` with a minimal `exports` map so the alias target's package-resolution hints line up

## Smoke test

`packages/webapp/tests/vendor/just-bash-smoke.test.ts` asserts that `parse`, `Parser`, `ParseException`, `LexerError`, `serialize`, `BashTransformPipeline`, `CommandCollectorPlugin`, `TeePlugin`, and the AST type aliases are all reachable from `'just-bash'` at both runtime and type level. If that test goes red, either the vendor was silently broken by a partial re-copy or someone deleted the vendor prematurely.

## Removal plan

Delete this entire `packages/webapp/src/vendor/just-bash/` directory in a single commit when **all** of the following are true:

1. An upstream `just-bash` release — at least `>= 2.15.0` — is published on npm that re-exports the same identifiers from `src/browser.ts`
2. Our root `package.json` has been bumped to that version and `npm install` succeeds
3. The `just-bash` alias is removed from `packages/webapp/vite.config.ts`, `packages/chrome-extension/vite.config.ts`, and `vitest.config.ts`
4. The `just-bash` entry is removed from `tsconfig.json` `compilerOptions.paths`
5. `npm run typecheck && npm run test && npm run build && npm run build -w @slicc/chrome-extension && npx prettier --check .` all pass against the upstream-published bundle
6. The smoke test `packages/webapp/tests/vendor/just-bash-smoke.test.ts` is deleted alongside the vendor (its entire purpose is guarding the vendor — once the vendor is gone, the upstream surface itself is the assertion)
