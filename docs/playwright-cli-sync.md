# playwright-cli Alignment with Official @playwright/cli

Slicc's `playwright-cli` shell command reimplements the official `@playwright/cli`
from scratch over raw CDP. This page explains how the two stay aligned and what to do
when they diverge.

## Background

The official `playwright-cli` (npm: `@playwright/cli`) ships a machine-readable schema
inside `playwright-core`:

```
playwright-core/lib/tools/cli-client/help.json
```

This file is generated at build time from
[`packages/playwright-core/src/tools/cli-daemon/commands.ts`](https://github.com/microsoft/playwright)
in the `microsoft/playwright` repo. It defines every command's positional args,
typed flags, and help text. It is the source of truth for what the official CLI
exposes.

`help.json` ships inside the npm package, so it is always available locally once
`@playwright/cli` is installed — no GitHub access needed.

## Slicc's command manifest

`packages/webapp/src/shell/supplemental-commands/playwright/slicc-commands.json`
mirrors `help.json`'s shape: one entry per registered command, with its args and flags.

```json
{
  "_slicc_only": ["teleport", "fetch", "frames", ...],
  "_official_skip_flags": {
    "open": ["browser", "config", "headed", "persistent", "profile"],
    "screenshot": ["full-page"]
  },
  "commands": {
    "goto":       { "args": ["url"], "flags": { "tab": "string", ... } },
    "click":      { "args": ["ref", "button"], "flags": { "tab": "string" } },
    ...
  }
}
```

**Keep this file in sync with `handlers/index.ts`.** When you add, remove, or rename
a handler, update the manifest too. The sync script validates this.

### Control keys

| Key                    | Purpose                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `_slicc_only`          | Commands that only exist in Slicc (teleport, fetch, HAR recording, etc). Not treated as gaps.                              |
| `_official_skip_flags` | Flags present in the official schema but intentionally absent from Slicc, keyed by command name. Not treated as flag gaps. |

Commands intentionally not implemented at all (different operational model — browser
session management, test debugger, Playwright dashboard) are hardcoded in
`officialSkipCommands` inside the sync script itself.

## The sync script

```bash
node packages/dev-tools/tools/playwright-cli-sync.mjs
```

Diffs `help.json` against `slicc-commands.json` and reports three gap categories:

- **Missing commands** — in official, absent from Slicc
- **Flag gaps** — flags on existing commands missing from Slicc
- **Arg gaps** — required positional args missing from Slicc (detected via `<arg>` vs
  `[arg]` notation in the help text, since `help.json` doesn't encode optionality in
  the args array itself)

Exits 1 if any gaps are found. Use `--json` for machine-readable output.

### Resolution order for `help.json`

1. `--help-json=<path>` CLI override
2. `playwright-core` in repo's `node_modules` (resolved via `package.json` subpath to
   avoid the `exports` map restriction on direct deep imports)
3. Globally-installed `playwright-cli` binary (resolved via `realpathSync`)

### Options

| Flag                      | Effect                                                     |
| ------------------------- | ---------------------------------------------------------- |
| `--json`                  | Emit structured JSON instead of human-readable text        |
| `--help-json=<path>`      | Override the path to `help.json`                           |
| `--slicc-manifest=<path>` | Override the path to `slicc-commands.json` (used by tests) |

## When to run it

**After upgrading `@playwright/cli`** — the most important trigger. Each release may
add new commands or flags to `help.json`. Run the script immediately after the version
bump. For each new gap, decide:

- Implement it → add the handler, update the manifest, gap disappears.
- Skip it intentionally → add to `officialSkipCommands` (hardcoded in the script) or
  to `_official_skip_flags` / `_slicc_only` in the manifest.

**After adding a new handler** — update `slicc-commands.json` to include the new
command, then run the script to confirm zero false positives.

**Before an implementation sprint** — run to get the current gap list as a
prioritized checklist.

## Current gap state

As of the initial implementation, Slicc is missing 30 commands and has 8 flag gaps.
The gaps are organized into implementation phases in the project plan. Run the script
to see the live state.

## Catching future changes automatically (optional)

The sync script is currently a manual tool. Two options for automating it:

**Renovate PR gate** — add a CI step to the Renovate workflow that runs the script
whenever `@playwright/cli` is bumped. A non-zero exit blocks the Renovate PR, forcing
a conscious decision before the upgrade merges. This prevents silent drift.

**Pre-push hook** — add `node packages/dev-tools/tools/playwright-cli-sync.mjs` to
the Husky pre-push hook. Catches manifest staleness when a developer adds a handler
without updating `slicc-commands.json`. Lower stakes than the Renovate gate since the
manifest being stale is a false-positive problem, not a real gap.

Neither is wired up yet. For now, rely on running the script manually before
implementation work.

## Adding a new playwright-cli command

When implementing one of the gaps reported by the sync script:

1. Add the handler in `packages/webapp/src/shell/supplemental-commands/playwright/handlers/`
2. Register it in `handlers/index.ts`
3. Add the entry to `slicc-commands.json` with the correct args and flags
4. Add it to `AUTO_SNAPSHOT_COMMANDS` in `state.ts` if it mutates page state
5. Update `packages/webapp/src/shell/supplemental-commands/playwright/help.ts`
6. Update `packages/vfs-root/workspace/skills/playwright-cli/SKILL.md`
7. Add tests in `packages/webapp/tests/shell/supplemental-commands/playwright-command.test.ts`
8. Run `node packages/dev-tools/tools/playwright-cli-sync.mjs` — it should no longer
   list the command as a gap

See `docs/adding-features.md §4` for the handler implementation pattern.
