---
name: wiki
description: |
  Use this to build and query the shared knowledge base at /shared/wiki — an
  interlinked markdown wiki where knowledge compounds across sessions instead
  of being rediscovered. Use when the user wants to save knowledge durably,
  ingest an article or notes into the KB, ask what is already known about a
  topic, or check the wiki's health. Covers the `wiki` CLI (search, list,
  read, stats, links, orphans, recent, log) and the ingest / query / lint
  behaviors. Triggers on knowledge base, wiki, KB, ingest, research notes.
allowed-tools: bash
---

# wiki

`/shared/wiki` holds durable synthesized knowledge. Schema: `/shared/wiki/WIKI.md` — read before editing. Memory files keep a budgeted working set; dreaming moves overflow here.

```bash
wiki search <term>     # max 20 hits
wiki list [category]
wiki read <note>       # name, name.md, or category/name
wiki stats
wiki links <note>
wiki orphans
wiki recent [n]        # newest _raw/ (default 10)
wiki log [n]           # log.md entries (default 10)
```

Read-only CLI; zero scan = error.

**Ingest:** read source (don't edit; cite `/sessions/` in place) → entities/claims/`[[wikilinks]]` on both ends → update `index.md`, verify links, log `## [YYYY-MM-DD] ingest | <title>`.

**Query:** `index.md` first → synthesize with citations → file answer page → log `query`.

**Lint:** orphans + broken links/stale/contradictions; fix with consent; mark conflicts on both pages with `> ⚠ CONFLICT [YYYY-MM-DD]: …`; log `lint` + counts.

Log keywords exactly: `ingest` | `query` | `lint`. Filenames: lowercase, dash-separated, NFC. Full upstream: `upskill ai-ecoverse/skills --path skills/ --skill llm-wiki`.
