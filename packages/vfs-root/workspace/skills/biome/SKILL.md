---
name: biome
description: |
  Use this when checking, linting, or formatting code with SLICC's `biome`
  shell command. Covers its ipk prerequisites, config discovery, check, lint,
  and format modes, exit codes, and plain or JSON reporters.
allowed-tools: bash
---

# Biome

Thin wrapper over ipk WASM packages — not a bundled binary. Install first:

```bash
ipk add -g @biomejs/wasm-web @biomejs/js-api esbuild-wasm
```

No CDN fallback; missing packages print a pinned `ipk add` in `--help`/errors.

| Command                           | Behavior                                          |
| --------------------------------- | ------------------------------------------------- |
| `biome check <files...>`          | Lint + format check; `--write` applies formatting |
| `biome lint <files...>`           | Lint only                                         |
| `biome format <file>`             | Print formatted; `--write` updates                |
| `biome format --check <files...>` | Report unformatted only                           |

`format --write` and `--check` conflict. Piped input needs `--stdin-file-path <path>`.

`--config-path <file>` or walk from first target (or cwd for stdin) toward `/`; `biome.json` beats `biome.jsonc`. Comments/trailing commas ok; no `extends`.

Default reporter: plain text. `--reporter json` / `--json` → one JSON doc (`summary`, `diagnostics`, `files`). Exit `0` clean; `1` findings/unformatted/missing/bad config; `2` usage/`--config-path` error. Treat `1` as failure even for warnings-only.
