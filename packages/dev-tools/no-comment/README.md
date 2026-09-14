# no-comment

`main` stays the documented tree. `no-comment` is a derived, comment-free
mirror used as a benchmark: same code, no comments, no developer docs, so we
can measure whether those actually help agents write code.

## What is stripped

- Source comments in TS/JS, CSS, Swift, Go, shell, YAML, HTML, JSONC
- JSDoc and `///` / `/* */` documentation comments
- `CLAUDE.md`, `AGENTS.md`, `docs/*.md`, package READMEs, `.agents/skills`,
  `.claude/skills`, Copilot instruction files

## What is kept

- Compiler/linter directives (`@ts-expect-error`, `biome-ignore`,
  `//go:build`, `swiftlint:`, `shellcheck`, `/*#__PURE__*/`, shebangs, …)
- `LICENSE`
- Product markdown under `packages/vfs-root/` (runtime agent skills and
  `shared/CLAUDE.md`)
- A one-paragraph root `README.md` that names the branch

## Commands

```bash
node packages/dev-tools/no-comment/strip.mjs --root .
node packages/dev-tools/no-comment/check.mjs
```

`npm run lint:no-comments` is chained into `lint` / `lint:ci`. Without a
`.no-comment` marker (i.e. on `main`) it is a no-op. On the mirrored branch
it fails if comments or developer docs come back.

Pushes to `main` run `.github/workflows/no-comment-mirror.yml`, which strips
the new tree, formats it (`biome format`, `prettier`), and commits it onto
`no-comment` with a `No-Comment-Of: <sha>` trailer.
