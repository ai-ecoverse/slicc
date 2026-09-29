---
name: upgrade
description: |
  Use this when you receive an `[Upgrade Event: x.y.z→a.b.c]` lick — fired on
  boot whenever the bundled SLICC version differs from the previous run. The
  lick renders a binary action card: `lick_confirm` to Update workspace files
  (three-way merge of bundled `vfs-root` files against the user's local edits)
  or `lick_dismiss` to clear it. Reviewing the changelog from GitHub, and
  checking installed skills for updates with `upskill list --outdated`, are
  separate steps you can run first. Never auto-applies; the user resolves the
  card.
allowed-tools: bash, read_file, write_file, edit
---

# Upgrade

Boot detects bundled version ≠ last run → `upgrade` lick.

## Event shape

```text
[Upgrade Event: 0.4.1→0.5.0]
SLICC was upgraded from `0.4.1` to `0.5.0`.
Released: 2026-04-15T12:00:00Z
```

Versions are git tags on `https://github.com/ai-ecoverse/slicc`. Resolve with `Lick ID:` from message.

## Card actions

Runtime renders a binary action card — you do not render a sprinkle.

- **`lick_confirm` → Update workspace files.** Runs `upgrade apply` with stored release versions. Card flips ✓.
- **`lick_dismiss` → clear card.** Nothing changes; card mutes ✗. Won't fire again until next upgrade.

Never auto-run the merge. Changelog review is separate — run first to help the user decide.

**Before `lick_confirm` or `lick_dismiss`:** check `list_scoops`. A `processing` scoop may lose in-flight work when the runtime moves versions — **no notification**; it can look `ready` / finished. Wait until every scoop is idle, or re-feed any that were still working.

## Version

`uname -r` — running version. `upgrade status` — last booted, pending merge, exact `upgrade apply` line. Realm: `globalThis.SLICC_VERSION`.

## Changelog (optional, not card action)

```bash
curl -sSL "https://api.github.com/repos/ai-ecoverse/slicc/compare/v${FROM_VERSION}...v${TO_VERSION}" \
  | node -e 'const j=JSON.parse(process.stdin.read()||"{}");console.log((j.commits||[]).map(c=>"- "+c.commit.message.split("\n")[0]).join("\n"))'
```

Group by conventional-commit type. 404 → `https://github.com/ai-ecoverse/slicc/releases/tag/v${TO_VERSION}`.

## `upgrade apply` (via `lick_confirm`)

```bash
upgrade apply --from="${FROM_VERSION}" --to="${TO_VERSION}"
```

`lick_confirm` runs this through the cone shell — do not run a second merge after confirming.

Merges bundled files at both release refs under `/workspace/skills`, `/shared/sprinkles`, `/shared/sounds`, `/etc` via three-way merge. `/etc/MEMORY.md` and policy files (`sudoers`, `models`, `llmstxtignore`) seeded only when absent — the only way rule changes reach existing profiles (including `Write /etc/models` gate). JSON classifies every path: `auto-applied`, `merged-clean`, `kept-local`, `needs-review`, `unchanged`, `added-new`. Exit 1 → discovery/fetch failed or needs review; conflicts in collision-safe sidecar, live file unchanged. Never deletes local-only files. `/etc/sudoers` edits still raise their own approval — the card authorizes the merge, not the policy edit. Can also run manually with explicit `--from`/`--to` for recovery.

## Installed skills (optional, not card action)

```bash
upskill list --outdated
upskill update --dry-run
upskill update              # all with provenance
upskill update <skill>
```

Card covers bundled files only — `upskill`-installed skills drift silently.

`upskill list --outdated` reuses `upskill update --dry-run` classification (`.upskill` provenance vs latest upstream). Skills with no record omitted with skipped count. Exit 0 unless a check itself failed.

- **Dotfiles never touched** — credentials and `.upskill` survive updates/`--force`. Never hand-copy credential files.
- **`kept-local`** marks dotfiles and user-added files — correct outcome.
- No provenance → `upskill update <skill> --from <owner>/<repo> --dry-run` first, then without. First update never deletes.
- Skipped list + scoped "All N skills with provenance are current" is not failure; runtime-bundled skills have no record.

## Do not

- `lick_confirm`/`lick_dismiss` while scoops `processing`.
- Run `upgrade apply` before user confirms.
- Delete files removed from new release.
- Modify paths outside `/workspace/skills/`, `/shared/sprinkles/`, `/shared/sounds/`, `/etc/` without user scope.
- Run `upskill update` without user ask.
- Advance bundled version marker yourself.
