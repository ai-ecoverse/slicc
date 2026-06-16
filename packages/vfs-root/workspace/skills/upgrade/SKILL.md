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

- **`lick_confirm` → Update workspace files.** This is the primary action: run the three-way merge of bundled `vfs-root` content into the user's VFS (see below). Only confirm once the user has decided to pull the new files.
- **`lick_dismiss` → clear the card.** Use this when the user wants to skip the merge; nothing is changed and the card mutes (✗). The lick will not fire again until the next upgrade.

The card flips to ✓ on confirm / muted ✗ on dismiss. Never auto-run the merge — the user must choose. Reviewing the changelog is **not** a card action; it is a separate step you can run first to help the user decide.

## Changelog review (separate step — not a card action)

Before the user decides, you can fetch the GitHub compare API for the two tags and summarize the result. This is optional and independent of the card; it does not resolve the lick.

```bash
# The repo is public — no auth required for the compare endpoint.
curl -sSL "https://api.github.com/repos/ai-ecoverse/slicc/compare/v${FROM_VERSION}...v${TO_VERSION}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.commits.map(c=>"- "+c.commit.message.split("\n")[0]).join("\n"))})'
```

Show the conventional-commit messages grouped by type (`feat`, `fix`, `chore`, ...). If the compare returns 404 (tags missing), fall back to the GitHub releases page URL: `https://github.com/ai-ecoverse/slicc/releases/tag/v${TO_VERSION}`.

## Three-way merge (the `lick_confirm` / "Update workspace files" action)

The user's VFS may have local edits to bundled skills, sprinkles, or scripts. The three inputs to the merge are:

- **base** = the bundled vfs-root file at the **previous** release tag (`v${FROM_VERSION}`). This is what the user originally received and is the common ancestor of both sides.
- **ours** = the file currently in the user's VFS (which may equal `base` if untouched, or may carry local edits).
- **theirs** = the bundled vfs-root file at the **new** release tag (`v${TO_VERSION}`).

Concretely:

1. Identify candidate paths under `/workspace/skills/` and `/shared/sprinkles/` that match bundled files. Per file:
   - Fetch `base` from `https://raw.githubusercontent.com/ai-ecoverse/slicc/v${FROM_VERSION}/packages/vfs-root/<rest-of-path>`.
   - Fetch `theirs` from `https://raw.githubusercontent.com/ai-ecoverse/slicc/v${TO_VERSION}/packages/vfs-root/<rest-of-path>`.
   - Read `ours` from the user's VFS at the equivalent runtime path (e.g. `/workspace/skills/<name>/SKILL.md`).
2. Decide per file:
   - If `base == theirs`: nothing changed upstream → leave the user's file alone (no merge needed).
   - If `ours == base` and `base != theirs`: the user has not edited this file → safe fast-forward to `theirs`.
   - If `ours != base` and `base != theirs`: real 3-way merge. Write the three sides to `/tmp` and let `git merge-file` produce the result:
     ```bash
     git merge-file --stdout /tmp/ours /tmp/base /tmp/theirs > /tmp/merged
     ```
     Exit code 0 → clean merge; write `/tmp/merged` back to the VFS path. Non-zero exit means conflicts (`<<<<<<<` markers in the output) — surface the conflicting hunks and let the user pick.
3. Present the per-file outcome as a summary table (`auto-applied`, `kept-local`, `needs-review`) and stop. Do not silently overwrite anything.

## Do not

- Do not run a merge before the user confirms. The merge runs only as the `lick_confirm` ("Update workspace files") action; if the user dismisses, do nothing.
- Do not delete files that no longer exist in the new release — many users name-collide their own scripts with bundled ones; deletion is too dangerous to automate.
- Do not modify files outside `/workspace/skills/`, `/shared/sprinkles/`, and `/shared/sounds/` without the user explicitly extending the scope.
- Do not advance the bundled version marker yourself. The runtime advances it automatically once this lick has been routed; if the user dismisses, the lick will not fire again until the next upgrade.
