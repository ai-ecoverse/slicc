---
name: biome
description: |
  Use this when checking, linting, or formatting code with SLICC's `biome`
  shell command. Covers its ipk prerequisites, config discovery, check, lint,
  and format modes, exit codes, and plain or JSON reporters.
allowed-tools: bash
---

# Biome

Use the `biome` shell command for Biome checks inside the VFS. It is a thin wrapper over ipk-installed WASM packages, not a bundled Biome binary.

## Install prerequisites

Install all three backing packages before linting or formatting:

```bash
ipk add -g @biomejs/wasm-web @biomejs/js-api esbuild-wasm
```

There is no CDN fallback. If a package is missing, follow the pinned `ipk add` command printed by `biome --help` or the error message.

## Commands

| Command                           | Behavior                                                      |
| --------------------------------- | ------------------------------------------------------------- |
| `biome check <files...>`          | Lint and check formatting. Add `--write` to apply formatting. |
| `biome lint <files...>`           | Lint only; never writes files.                                |
| `biome format <file>`             | Print formatted source. Add `--write` to update files.        |
| `biome format --check <files...>` | Report unformatted files without printing or writing changes. |

`format --write` and `format --check` are mutually exclusive. For piped input, pass `--stdin-file-path <path>` so Biome selects the correct parser.

## Configuration

Use `--config-path <file>` to select a config explicitly. Otherwise, discovery starts at the first target file's directory, or the current directory for stdin, and walks toward `/`. At each directory, `biome.json` takes precedence over `biome.jsonc`.

The wrapper accepts comments and trailing commas. It does not resolve `extends`.

## Reporters

The default `plain` reporter emits diagnostics as plain text without HTML entities, HTML tags, or added ANSI escapes.

Use `--reporter json` or `--json` for one JSON document on stdout with `summary`, `diagnostics`, and `files` fields. JSON diagnostic text is not written to stderr, and selecting JSON does not change the exit code.

## Exit codes

| Code | Meaning                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | No findings, and checked files are formatted.                                                                          |
| `1`  | Error, fatal, or warning diagnostics; unformatted checked files; missing packages/files; or invalid discovered config. |
| `2`  | Usage error, including a missing or invalid explicit `--config-path`.                                                  |

Treat code `1` as a failed check even when Biome reports only warnings.
