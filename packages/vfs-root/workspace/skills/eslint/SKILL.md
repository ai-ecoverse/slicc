---
name: eslint
description: |
  Use this when linting JavaScript or TypeScript with SLICC's `eslint` shell
  command, including `.jsh` and `.bsh` scripts. Covers its ipk prerequisites,
  flat-config discovery, global ignores, `--fix`, formatters, and exit codes.
allowed-tools: bash
---

# ESLint

The `eslint` command lints files in the VFS. It wraps the ipk-installed ESLint's
`Linter`, not the `eslint` binary — so config discovery, target expansion,
ignores, fixes, and reporting are this wrapper's, and the rules, parser, and
messages are ESLint's own.

## Install prerequisites

```bash
ipk add -g eslint @eslint/js esbuild-wasm
```

All three are needed: `eslint` supplies the linter, `@eslint/js` supplies the
`js.configs.*` presets most configs extend (ESLint no longer bundles it), and
`esbuild-wasm` is what lets an ESM `eslint.config.js` load at all. A missing
package surfaces as a single error naming this command.

`eslint --version` prints the installed ESLint version and needs no config.

## Commands

| Command                                  | Behavior                                              |
| ---------------------------------------- | ----------------------------------------------------- |
| `eslint <files...>`                      | Lint files; directories are walked recursively.       |
| `eslint --fix <files...>`                | Lint and write fixes back.                            |
| `eslint --fix-dry-run <files...>`        | Report which files `--fix` would rewrite; write none. |
| `eslint --stdin --stdin-filename <path>` | Lint piped input as if it were `<path>`.              |

`--stdin-filename` is a VIRTUAL name, used only to pick the config that applies.
Nothing is written to it, and `--fix` with `--stdin` is refused for that reason —
use `--fix-dry-run`, which prints the fixed code to stdout.

Useful flags: `-c/--config <file>`, `--no-config-lookup`, `--rule '<json>'`,
`-f/--format <stylish\|json\|compact>`, `--ext .js,.mjs`, `--max-warnings <n>`,
`--quiet`. Run `eslint --help` for the full list.

## Configuration

Flat config only. Without `--config`, discovery starts at the first target's
directory — the directory itself when the target _is_ a directory — or the
current directory for stdin, then walks toward `/`, taking the first of
`eslint.config.js`, `.mjs`, `.cjs`. ESM and CommonJS configs both load;
`@eslint/js` and any other installed plugin can be imported from one.

A TypeScript config (`eslint.config.ts`) is rejected: it needs a loader ESLint
resolves through its own CLI, which is not on this path.

Relative `files` and `ignores` patterns resolve against the config file's
directory, so a target outside the shell's current directory still matches.

To lint without a config file, combine `--no-config-lookup` with `--rule`:

```bash
eslint --no-config-lookup --rule '{"eqeqeq":"error"}' src/app.js
```

### Ignores

Top-level `ignores`-only config entries are applied by this wrapper, because
`Linter` does not honor global ignores on its own. `node_modules` and `.git` are
never walked into.

Patterns are evaluated in order, so a later `!` pattern re-includes what an
earlier one ignored — `ignores: ['**/*.js', '!src/**/*.js']` lints `src` and
nothing else.

A file you name on the command line that the config ignores is reported as
`File ignored because of a matching ignore pattern.` rather than silently
passing, so a stale path is not mistaken for a clean one. A file reached by
walking a directory is skipped quietly.

## Linting `.jsh` and `.bsh` scripts

Both run as an async function body, so top-level `await` and top-level `return`
are valid in them. The wrapper wraps the body before ESLint parses it and maps
line numbers back, so a bare `return` does not produce a phantom parse error and
reported positions match the real file. Findings that belong only to that
injected wrapper are dropped, so no rule reports against a line the file does not
have. `--fix` writes back only when the fix left the wrapper untouched; a rule
that reindents the whole body (`indent`) is reported as unfixable and the file is
left alone.

These scripts run with SLICC's realm globals, so give them to ESLint or
`no-undef` flags every one of them:

```js
export default [
  {
    files: ['**/*.jsh', '**/*.bsh'],
    languageOptions: {
      globals: { require: 'readonly', process: 'readonly', console: 'readonly', fetch: 'readonly' },
    },
    rules: { eqeqeq: 'error' },
  },
];
```

## Reporters

`stylish` (default) prints grouped, aligned findings and a problem summary.
`compact` prints one line per finding. `json` prints one document on stdout with
`summary` and `results` fields, where each result carries ESLint's own message
objects; nothing is written to stderr and the exit code does not change.

## Exit codes

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | No errors, and warnings within `--max-warnings`.                                |
| `1`  | Error-severity findings, or warnings over `--max-warnings`.                     |
| `2`  | Usage error, a missing or unusable config, a missing package, a missing target. |

`--quiet` drops warnings from the report and disables the `--max-warnings`
check, but never hides a fatal parse error.
