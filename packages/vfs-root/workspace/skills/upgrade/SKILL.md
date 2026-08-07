---
name: upgrade
description: |
  Use this when you receive an `[Upgrade Event: x.y.z→a.b.c]` lick — fired on
  boot whenever the bundled SLICC version differs from the previous run. The
  lick renders a binary action card: `lick_confirm` to Update workspace files
  (three-way merge of bundled `vfs-root` files against the user's local edits)
  or `lick_dismiss` to clear it. Reviewing the changelog from GitHub is a
  separate step you can run first. Never auto-applies; the user resolves the
  card.
allowed-tools: bash, read_file, write_file, edit_file
---

# Upgrade

When SLICC boots and discovers that the bundled version (baked into the build at release time from the root `package.json`) differs from the version it was last seen running, it emits an `upgrade` lick to the cone. This skill describes how to react.

## Event shape

You receive a message like:

```text
[Upgrade Event: 0.4.1→0.5.0]

SLICC was upgraded from `0.4.1` to `0.5.0`.
Released: 2026-04-15T12:00:00Z

Use the **upgrade** skill (...)
```

The two version strings (`from`, `to`) are valid git tags on `https://github.com/ai-ecoverse/slicc` — the public source repository. The lick message carries a `Lick ID:` line — you resolve the card with that id.

## What to do when you receive an upgrade lick

The runtime renders the upgrade lick as a binary action card automatically — you do not render a sprinkle. The card has exactly two outcomes, which you drive with the lick tools using the `Lick ID` from the message:

- **`lick_confirm` → Update workspace files.** This runs `upgrade apply` with the stored release versions. Only confirm once the user has decided to pull the new files.
- **`lick_dismiss` → clear the card.** Use this when the user wants to skip the merge; nothing is changed and the card mutes (✗). The lick will not fire again until the next upgrade.

The card flips to ✓ on confirm / muted ✗ on dismiss. Never auto-run the merge — the user must choose. Reviewing the changelog is **not** a card action; it is a separate step you can run first to help the user decide.

## Changelog review (separate step — not a card action)

Before the user decides, you can fetch the GitHub compare API for the two tags and summarize the result. This is optional and independent of the card; it does not resolve the lick.

```bash
# The repo is public — no auth required for the compare endpoint.
# stdin here is fully buffered, so read() drains the whole response in one shot.
curl -sSL "https://api.github.com/repos/ai-ecoverse/slicc/compare/v${FROM_VERSION}...v${TO_VERSION}" \
  | node -e 'const j=JSON.parse(process.stdin.read()||"{}");console.log((j.commits||[]).map(c=>"- "+c.commit.message.split("\n")[0]).join("\n"))'
```

Show the conventional-commit messages grouped by type (`feat`, `fix`, `chore`, ...). If the compare returns 404 (tags missing), fall back to the GitHub releases page URL: `https://github.com/ai-ecoverse/slicc/releases/tag/v${TO_VERSION}`.

## Applying workspace files (the `lick_confirm` action)

`lick_confirm` runs the browser-native command below through the cone shell using the versions stored with the lick. Do not run a second merge after confirming.

```bash
upgrade apply --from="${FROM_VERSION}" --to="${TO_VERSION}"
```

The command discovers bundled files at both release refs under `/workspace/skills`, `/shared/sprinkles`, and `/shared/sounds`, plus the single file `/shared/MEMORY.md` (the memory-curator contract, seeded only when absent — this merge is the only way a curator-rule change reaches an existing workspace); prefetches and preflights every path; then applies safe updates with `VirtualFS` and the built-in three-way merge. Its JSON output classifies every bundled path as `auto-applied`, `merged-clean`, `kept-local`, `needs-review`, `unchanged`, or `added-new`.

An exit code of `1` means discovery/fetch failed or at least one path needs review. Conflicts are written to the reported collision-safe sidecar while the live file remains unchanged. Show the JSON summary and sidecar paths to the user; never copy conflict markers into the live file automatically. The command never deletes local-only files.

The command can also be run directly with explicit release versions for manual recovery, but an upgrade card still requires the user's confirmation before changing files.

## Do not

- Do not run `upgrade apply` before the user confirms. Confirmation runs it automatically; dismissal runs nothing.
- Do not delete files that no longer exist in the new release — many users name-collide their own scripts with bundled ones; deletion is too dangerous to automate.
- Do not modify files outside `/workspace/skills/`, `/shared/sprinkles/`, `/shared/sounds/`, and `/shared/MEMORY.md` without the user explicitly extending the scope.
- Do not advance the bundled version marker yourself. The runtime advances it automatically once this lick has been routed; if the user dismisses, the lick will not fire again until the next upgrade.
