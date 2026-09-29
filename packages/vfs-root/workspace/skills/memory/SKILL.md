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

One markdown file per cone: `/workspace/CLAUDE.md` (primary), `/cones/<folder>/CLAUDE.md` (extra). Agents write via `memory_write` only (budget-enforced). After freeze, a curator scoop rewrites from the archive. Pass reads only `visiblePaths` from `/etc/MEMORY.md`; blind reads are noted and refused as "missing" facts (slicc#3459). Live archives (`/sessions/live-*.md`) mined slice-wise (`curatedThrough`). Ledger: `/sessions/index.json` (`memoryCuratedAt` / `memoryFailed` / `memoryPending` / `memorySkipped`).

## Commands

```bash
memory show [--cone <folder>]
memory status [--json] [--check]
memory log [--limit N]
memory curate [--archive <file>] [--cone <folder>]
memory dream [--cone <folder>] [--all] [--wait]
```

## When to use

- "What do you remember?" → `memory show`
- Missing fact → `memory log`; systemic → `memory status --check`
- `memoryFailed` → fix cause, `memory curate --archive <file>`
- Bloated/duplicate memory → `memory dream` (`--wait` for report; `--all` all cones). Gelatiere nightly runs `memory dream --all`.
- Extra cones: `--cone <folder>` (`cone` or `/cones/<folder>`)

## `memory status`

- **Budget** — logarithmic with archive count.
- **Curation tally** — curated / failed / pending / skipped / unmarked.
- **`--check`** — non-zero on failed curation or success with empty/missing primary memory.
- **`Scheduled:`** — kernel health (~90s post-boot, daily) → `/sessions/.curation/health.json`.

## Notes

- `memory curate` = freezer pass (snapshot → curator → three-way merge). Minutes; report on completion.
- `memory dream` — same `/etc/MEMORY.md` instructions (`dreamTimeoutSeconds`). With agentic memory, mines live transcript slice first. Outcome: `/sessions/.curation/dream-<date>-<cone>.md/status.json`.
- Over-budget reference → `/shared/wiki/` (schema: `/shared/wiki/WIKI.md`; `wiki` skill) with pointer in memory file.
- Manual pass reconciled at boot via bridge receipt.
- All except `status` need **Memory v2** (Settings → Experimental).
