# biome-jsh — a jsh-aware Biome runner

Biome's CLI ignores `.jsh` / `.bsh` files, so linting them means renaming each
one to `.js` first. But SLICC shell scripts run as an **AsyncFunction body**
(see `kernel/realm/realm-module-system.ts`): top-level `await` **and** top-level
`return` are both valid. A naive rename makes Biome parse the body as a module
and emit a bogus error:

```
× Illegal return statement outside of a function
```

`biome-jsh` fixes this. For every `.jsh` / `.bsh` file it:

1. wraps the body in `async function __slicc() { … }` (the same shape the
   runtime uses), so top-level `await`/`return` parse cleanly;
2. writes the wrapped content to a temp `.js` file and runs Biome on it in
   **file mode** with `--reporter=github`;
3. shifts every diagnostic back onto the real file — the wrapper prefix is one
   newline-terminated line at column 0, so only the line number moves (columns
   are already correct) — and rewrites the temp path to the real `.jsh` path.

`.js` / `.ts` / `.json` / … files pass straight through, unwrapped.

This is the single jsh-aware runner meant to replace the ad-hoc
"copy-to-`.js`, lint, rename back" hack in downstream CI (e.g.
`ai-ecoverse/skills`). The wrap/unwrap/span-shift logic in
[`jsh-biome-source.mjs`](./jsh-biome-source.mjs) is a byte-aligned mirror of the
in-app Biome command
(`packages/webapp/src/shell/supplemental-commands/jsh-biome-source.ts`, WASM
path); this CLI is the binary path.

## Usage

```sh
biome-jsh check  [paths...]           # lint + format-check (github reporter)
biome-jsh lint   [paths...]           # lint only, no format-check
biome-jsh format [paths...]           # print formatted output to stdout
biome-jsh format --write [paths...]   # format files in place
```

Paths may be files or directories (walked recursively; `node_modules` and
`.git` skipped). `check` exits non-zero when any file has an error or is not
formatted; `lint` skips the format-check (useful for repos that don't enforce
formatting on legacy files). Both emit GitHub Actions annotations on stdout so
CI surfaces them inline.

```sh
biome-jsh check skills/
```

## Relationship to the in-app `biome` command

`biome-jsh` and the in-app wrapper share byte-aligned `.jsh`/`.bsh`
wrap/unwrap/span-shift helpers, but they are intentionally different frontends:

- `biome-jsh` runs the native `@biomejs/biome` binary and uses its normal upward
  config discovery. The in-app command loads the WASM API and implements VFS
  discovery plus an explicit `--config-path`.
- `biome-jsh check` and `lint` always request GitHub Actions annotations. The
  in-app command converts the WASM API's HTML diagnostics to plain text.
- `biome-jsh` supports `check`, `lint`, `format`, and `format --write`; it does
  not implement the in-app `format --check`, `--config-path`, or
  `--stdin-file-path` flags. Use `biome-jsh check` for a format gate.
- `biome-jsh` exits `1` for errors, missing files, or unformatted files; warning
  annotations alone do not fail it. The in-app command exits `1` for warnings too.

## Biome binary

`@biomejs/biome` is a declared dependency but the binary is **resolved at
runtime**, not bundled: `biome-jsh` looks for `node_modules/.bin/biome` walking
up from the current directory and from its own location, or uses `$BIOME_BIN`.
Any already-installed Biome is reused, so no fresh install is required.

## Published package

Published to npm as **`@ai-ecoverse/biome-jsh`** (public) by slicc's
semantic-release pipeline, but only on releases that actually change this
directory — the `--gate=biome-jsh-version` / `--gate=biome-jsh` steps in
`.releaserc.json` (see `packages/dev-tools/tools/release-native.mjs`) skip the
version stamp and the publish otherwise, so unchanged code is never republished.
Published versions are still SLICC release versions, just not every one of them.
Downstream repos consume it as a dev dependency:

```sh
npm i -D @ai-ecoverse/biome-jsh
```

then run `npx biome-jsh check <paths>` in CI — it reuses the repo's own
already-installed `@biomejs/biome`, so there's nothing to rename and no false
`return`/`await` parse errors.

## Layout

| File                   | Role                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `biome-jsh.mjs`        | CLI entry (I/O: file walking, temp files, spawning Biome).      |
| `lib.mjs`              | Pure logic: github-annotation parse / shift / rewrite.          |
| `jsh-biome-source.mjs` | Pure wrap / unwrap / span-shift helpers (mirror of the webapp). |

Tests are co-located `*.test.mjs` and run under the repo's `dev-tools` Vitest
project. The integration suite spawns the real Biome binary and skips cleanly
when none is installed.
