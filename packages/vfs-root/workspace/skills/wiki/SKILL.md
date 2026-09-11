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

# wiki — the shared knowledge base

`/shared/wiki` is the compounding layer of SLICC's memory: per-cone memory files
(`/workspace/CLAUDE.md`) hold a small budgeted working set, session archives
hold everything raw, and the wiki in between holds synthesized knowledge as
interlinked pages every cone can read. The schema — layout, conventions, log
format — is `/shared/wiki/WIKI.md`; **read it before editing anything.** The
nightly memory-dreaming pass moves over-budget knowledge out of memory files
into wiki pages, so treat the wiki as where durable knowledge lives.

## The `wiki` CLI

```bash
wiki search <term>     # search pages by title and content (max 20 hits)
wiki list [category]   # list pages, optionally one category
wiki read <note>       # print a page (name, name.md, or category/name)
wiki stats             # pages per category, raw sources, wikilink count
wiki links <note>      # inbound + outbound wikilinks for a page
wiki orphans           # pages with zero inbound links
wiki recent [n]        # newest raw sources in _raw/ (default 10)
wiki log [n]           # last N log.md entries (default 10)
```

The CLI is read-only and fails loudly when the wiki cannot be read — a zero
scan is an error, never a clean bill of health.

## Behaviors (from the llm-wiki pattern)

**Ingest** — new source in. Read the source (never edit it; session archives in
`/sessions/` count as sources, cited in place). Extract entities → pages,
claims → cited sentences, relationships → `[[wikilinks]]` on **both** endpoints.
Update `index.md`, verify every new wikilink resolves (create a stub or flag it
missing), append `## [YYYY-MM-DD] ingest | <title>` to `log.md`.

**Query** — question in. Read `index.md` first to discover pages, follow
cross-links, synthesize with wiki-backed citations, file the answer as a page,
update the index, log with keyword `query`.

**Lint** — health pass. `wiki orphans` plus a scan for broken wikilinks, stale
claims and contradictions. Fix with consent: repoint or stub broken links, add
inbound links to orphans, mark conflicts on **both** pages with
`> ⚠ CONFLICT [YYYY-MM-DD]: <description>`. Log with keyword `lint` and counts.

Log keywords are exactly `ingest`, `query`, or `lint` — never synonyms.

## Notes

- Keep filenames lowercase, dash-separated, and NFC-normalized — mixed Unicode
  normalization silently breaks wikilink resolution.
- The full upstream skill (sprinkle browser UI + a dedicated `wiki-ops` scoop)
  installs with `upskill ai-ecoverse/skills --path skills/ --skill llm-wiki`;
  this bundled skill pins the wiki root to `/shared/wiki` and carries the CLI.
