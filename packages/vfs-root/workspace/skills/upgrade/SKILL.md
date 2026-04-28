---
name: upgrade
description: React to upgrade lick events with a changelog review and a three-way merge of bundled vfs-root content
allowed-tools: bash, read_file, write_file, edit_file
---

# Upgrade

When SLICC boots and discovers that the bundled version (in `/shared/version.json`, baked at release time) differs from the version it was last seen running, it emits an `upgrade` lick to the cone. This skill describes how to react.

## Event shape

You receive a message like:

```text
[Upgrade Event: 0.4.1→0.5.0]

SLICC was upgraded from `0.4.1` to `0.5.0`.
Released: 2026-04-15T12:00:00Z

Use the **upgrade** skill (...)
```

The two version strings (`from`, `to`) are valid git tags on `https://github.com/ai-ecoverse/slicc` — the public source repository.

## What to do when you receive an upgrade lick

Render a single inline `.sprinkle-action-card` with two primary buttons. Quote both versions verbatim; never auto-run anything.

```shtml
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">
    SLICC upgraded
    <span class="sprinkle-badge sprinkle-badge--notice">FROM_VERSION → TO_VERSION</span>
  </div>
  <div class="sprinkle-action-card__body">
    <p style="margin:0 0 8px">SLICC was upgraded. You can review what changed and optionally pull the new bundled workspace files into your VFS.</p>
  </div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:'dismiss'})">Dismiss</button>
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:'review-changelog'})">Review changelog</button>
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:'merge-vfs-root'})">Update workspace files</button>
  </div>
</div>
```

## Changelog review (`action: 'review-changelog'`)

Fetch the GitHub compare API for the two tags and summarize the result for the user.

```bash
# The repo is public — no auth required for the compare endpoint.
curl -sSL "https://api.github.com/repos/ai-ecoverse/slicc/compare/v${FROM_VERSION}...v${TO_VERSION}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.commits.map(c=>"- "+c.commit.message.split("\n")[0]).join("\n"))})'
```

Show the conventional-commit messages grouped by type (`feat`, `fix`, `chore`, ...). If the compare returns 404 (tags missing), fall back to the GitHub releases page URL: `https://github.com/ai-ecoverse/slicc/releases/tag/v${TO_VERSION}`.

## Three-way merge (`action: 'merge-vfs-root'`)

The user's VFS may have local edits to bundled skills, sprinkles, or scripts. We treat the **previous bundled snapshot** (which lives in their VFS today) as the merge base. The user's actual VFS content is one branch; the **GitHub tag-to-tag diff** is the other.

Concretely:

1. Identify candidate paths under `/workspace/skills/` and `/shared/sprinkles/` that match the names of bundled files in this release. Per file:
   - **base** = the file currently in the VFS (representing the previous bundled snapshot the user has been running on)
   - **theirs** = the version from the new release tag fetched via `curl https://raw.githubusercontent.com/ai-ecoverse/slicc/v${TO_VERSION}/packages/vfs-root/<rest-of-path>`
   - **ours** = the same VFS file (since base and ours are the same starting point unless the user has edited it). The previous-release version is recovered from `https://raw.githubusercontent.com/ai-ecoverse/slicc/v${FROM_VERSION}/packages/vfs-root/<rest-of-path>`.
2. For each file, run a 3-way merge:
   - If `previous-release == VFS` and `previous-release != new-release`: the user has not edited this file → safe to fast-forward to `new-release`.
   - If `previous-release == new-release`: nothing changed upstream → leave the user's file alone.
   - If `previous-release != VFS` and `previous-release != new-release`: 3-way merge. Use `git merge-file` inside the WasmShell:
     ```bash
     # write the three sides to /tmp and let git merge-file produce the result
     git merge-file --stdout /tmp/ours /tmp/base /tmp/theirs > /tmp/merged
     ```
     If the merge succeeds cleanly, write the merged result to the VFS path and tell the user. If conflicts remain (non-zero exit + `<<<<<<<` markers), surface the conflicting hunks and let the user pick.
3. Present the per-file outcome as a summary table (`auto-applied`, `kept-local`, `needs-review`) and stop. Do not silently overwrite anything.

## Do not

- Do not run a merge without showing the action card first. The user must explicitly click `Update workspace files`.
- Do not delete files that no longer exist in the new release — many users name-collide their own scripts with bundled ones; deletion is too dangerous to automate.
- Do not modify files outside `/workspace/skills/`, `/shared/sprinkles/`, and `/shared/sounds/` without the user explicitly extending the scope.
- Do not advance the bundled version marker yourself. The runtime already advanced it before firing this lick; if the user dismisses, the lick will not fire again until the next upgrade.
