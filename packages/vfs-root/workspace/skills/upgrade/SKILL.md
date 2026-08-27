---
name: upgrade
description: |
  Use this when you receive an `[Upgrade Event: x.y.z→a.b.c]` lick — fired on
  boot whenever the bundled SLICC version differs from the previous run. The
  lick renders a binary action card: `lick_confirm` to Update workspace files
  (three-way merge of bundled `vfs-root` files against the user's local edits)
  or `lick_dismiss` to clear it. Reviewing the changelog from GitHub, and
  checking installed skills for updates with `upskill update --dry-run`, are
  separate steps you can run first. Never auto-applies; the user resolves the
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

## Which version am I running?

`uname -r` prints the running version. `upgrade status` adds the last-booted one, whether a merge is pending, and the exact `upgrade apply` line to run when it is — that is where `--from`/`--to` come from without a card on screen. Realm scripts read `globalThis.SLICC_VERSION`.

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

The command discovers bundled files at both release refs under `/workspace/skills`, `/shared/sprinkles`, `/shared/sounds`, and `/etc`, plus the single file `/shared/MEMORY.md`; prefetches and preflights every path; then applies safe updates with `VirtualFS` and the built-in three-way merge. `/shared/MEMORY.md` (the memory-curator contract) and the `/etc` policy files (`sudoers`, `models`, `llmstxtignore`) are seeded only when absent, so this merge is the only way a rule change in them reaches an existing profile — including approval rules such as the `Write /etc/models` gate. Applying a change to `/etc/sudoers` still raises its own approval prompt: the card authorizes the merge, not the policy edit. Its JSON output classifies every bundled path as `auto-applied`, `merged-clean`, `kept-local`, `needs-review`, `unchanged`, or `added-new`.

An exit code of `1` means discovery/fetch failed or at least one path needs review. Conflicts are written to the reported collision-safe sidecar while the live file remains unchanged. Show the JSON summary and sidecar paths to the user; never copy conflict markers into the live file automatically. The command never deletes local-only files.

The command can also be run directly with explicit release versions for manual recovery, but an upgrade card still requires the user's confirmation before changing files.

## Also check installed skills (separate step — not a card action)

The card only covers **bundled** files (`/workspace/skills`, `/shared/sprinkles`, `/shared/sounds`, `/shared/MEMORY.md`, `/etc`). Skills the user installed themselves with `upskill` are never touched by it, and they drift silently — a stale one can sit months behind upstream while still loading fine.

A new SLICC release is a good moment to check them. This is read-only:

```bash
upskill update --dry-run
```

It reads each skill's `.upskill` provenance record (written at install time: source repo, ref, resolved commit, file list) and compares the recorded commit against the ref's head. Skills whose commit has not moved report `already current` without downloading anything; the rest are fetched and classified with the same vocabulary as `upgrade apply` — `unchanged`, `updated`, `added`, `removed`, `kept-local`.

Report what would change and let the user decide. To apply:

```bash
upskill update              # every skill with provenance
upskill update <skill>      # just one
```

Notes worth knowing:

- **Dotfiles are never touched.** `upskill` will not modify or delete a dotfile in a skill directory, so credentials (`scripts/.config`) and the `.upskill` record survive updates and `--force` reinstalls. Never hand-copy a credential file "to be safe" — it is already safe, and moving it can break the skill.
- **`kept-local` is not a failure.** It marks dotfiles and files the user added themselves; leaving them is the correct outcome.
- A skill installed before provenance tracking reports `no install provenance`. If the user knows where it came from, record it in place — `upskill update <skill> --from <owner>/<repo> --dry-run` first, then without `--dry-run`. That first update never deletes anything, because nothing is attributable to a previous install yet.
- **The sweep tells you what it did not check.** Skills with no `.upskill` record are listed under `Skipped <n> skills with no install provenance` and the closing line is scoped to the ones it checked (`All 13 skills with provenance are current.`). That is not a failure and the exit code stays 0: the runtime-bundled skills legitimately have no record and `upgrade apply` keeps those current. Pass the rest on to the user — one `--from` per skill is all it takes for the sweep to cover them from then on. Do not read an unqualified `All skills are current.` into a run that printed a skipped list.

## Do not

- Do not run `upgrade apply` before the user confirms. Confirmation runs it automatically; dismissal runs nothing.
- Do not delete files that no longer exist in the new release — many users name-collide their own scripts with bundled ones; deletion is too dangerous to automate.
- Do not modify files outside `/workspace/skills/`, `/shared/sprinkles/`, `/shared/sounds/`, `/shared/MEMORY.md`, and `/etc/` without the user explicitly extending the scope.
- Do not run `upskill update` (without `--dry-run`) unless the user asks for it — the dry run is the safe default when you are volunteering the check.
- Do not advance the bundled version marker yourself. The runtime advances it automatically once this lick has been routed; if the user dismisses, the lick will not fire again until the next upgrade.
