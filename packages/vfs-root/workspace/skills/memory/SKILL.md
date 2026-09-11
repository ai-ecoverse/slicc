---
name: memory
description: |
  Use this when the user asks what SLICC remembers, why a remembered fact is
  missing or stale, whether memory curation ran, to re-run curation for an
  archived session, or to consolidate a bloated memory file. Covers the
  `memory` shell command (`show`, `status`, `log`, `curate`, `dream`), the
  per-cone memory files, and the curation ledger in /sessions/index.json.
  Requires the memory-v2 feature flag for everything except `memory status`.
allowed-tools: bash
---

# memory — inspect and manage durable cone memory

Durable memory is one markdown file per cone — `/workspace/CLAUDE.md` for the primary cone, `/cones/<folder>/CLAUDE.md` for extra cones. After a chat freezes, a memory-curator scoop rewrites that file from the archived session; `/sessions/index.json` is the per-archive ledger of whether that pass succeeded (`memoryCuratedAt`), failed (`memoryFailed`), is still owed (`memoryPending`), or was skipped by the user (`memorySkipped`).

## Usage

```bash
memory show [--cone <folder>]      # the cone's memory file, verbatim
memory status [--json] [--check]   # files, budget, curation tally, health
memory log [--limit N]             # per-archive ledger, newest first
memory curate [--archive <file>] [--cone <folder>]   # run a curator pass now
memory dream [--cone <folder>] [--all] [--wait]      # consolidate memory (dreamer pass)
```

## When to reach for it

- "What do you remember about me / this project?" → `memory show`.
- A fact you expected to be remembered is missing → `memory log` to see whether the session that established it was ever curated; `memory status --check` for systemic failures.
- After a failed curation (`memoryFailed` in the log) → fix the cause if visible (usually a missing provider or a timeout), then `memory curate --archive <that-file>`.
- The memory file has grown duplicated, contradictory, or over budget → `memory dream` (add `--wait` to see the dreamer's report; `--all` for every cone with a memory file). The gelatiere's nightly already runs `memory dream --all`, so reach for this manually only when it cannot wait.
- Extra cones keep separate memory: pass `--cone <folder>` to `show`, `curate`, and `dream`. The folder must exist (`cone`, or a `/cones/<folder>`); `curate` without it targets the cone the archive was frozen from.

## Reading `memory status`

- **Budget** grows logarithmically with the archived-session count; the curator is told to stay under it.
- **Curation tally** counts index entries by ledger state: curated / failed / pending / skipped / unmarked (pre-ledger or freshly frozen).
- **`--check`** exits non-zero on the two lying-memory shapes: any archive whose last curation attempt failed, or archives reporting success while the primary memory file is missing or empty. A clean run exits 0.
- **`Scheduled:`** shows the runtime's own health check — the kernel runs the same checks ~90s after boot and daily without being asked, persisting the numbers to `/sessions/.curation/health.json`. If that line says `never ran` long after boot, or names failures, the memory system needs attention even if nobody asked about it.

## Notes

- `memory curate` runs the exact pass the session freezer runs (snapshot → curator scoop → three-way merge), so concurrent edits to the memory file merge instead of being clobbered. It can take several minutes; the curator's closing report is printed when it lands.
- `memory dream` reads no session archive — the dreamer consolidates the memory file itself under `/shared/DREAMING.md`'s instructions, through the same staged draft and merge. Detached by default; the outcome lands in `/sessions/.curation/dream-<date>-<cone>.md/status.json`.
- When consolidation cannot fit everything, the dreamer moves reference knowledge into the shared wiki at `/shared/wiki/` (schema: `/shared/wiki/WIKI.md`; browse it with the `wiki` skill) and leaves a pointer line in the memory file.
- The command does not edit the ledger itself; a manual pass on a still-pending archive is reconciled by the boot catch-up through the bridge's receipt.
- Everything except `status` requires the **Memory v2** flag (Settings → Experimental).
