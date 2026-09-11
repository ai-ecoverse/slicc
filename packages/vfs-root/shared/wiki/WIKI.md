# Wiki Schema

The shared knowledge base — the compounding layer of SLICC's memory. Per-cone
memory files (`/workspace/CLAUDE.md`) hold the budgeted working set; this wiki
holds the knowledge that outgrows them, as interlinked pages that every cone
can read and search. Read this schema before editing; the `wiki` CLI and the
skill at `/workspace/skills/wiki/SKILL.md` implement it.

## Root

`/shared/wiki`

## Directory Layout

- `index.md` — master catalog of all pages (one-line blurbs, categories, links)
- `log.md` — append-only operation log (ingest / query / lint entries)
- `people/`, `projects/`, `tech/`, `work/`, `life/` — topic pages by category,
  one concept per file; create a category directory when its first page lands,
  and nest self-contained sub-workspaces under `projects/<name>/`
- `_raw/` — imported raw sources, named `YYYY-MM-DD_<slug>_<hash>.md`
  (read-only; never edited by the wiki layer)

## Sources

Raw sources are never modified — all synthesis lives in the wiki layer.
Session archives under `/sessions/*.md` are read-only sources too: cite them
in place, never copy them into `_raw/`.

## Conventions

- Wikilinks: `[[page-name]]`, written on **both** endpoints of a relationship
- Citations: `([source: _raw/<file>])` or `([source: /sessions/<file>])`
- Contradiction marker: `> ⚠ CONFLICT [YYYY-MM-DD]: <description>`
- Categories: comma-separated tags in index blurbs, e.g. `(ML, architecture)`
- Filenames: lowercase, dash-separated, **NFC-normalized** (mixed Unicode
  normalization breaks exact-match wikilink lookup invisibly)
- Log keywords are exactly `ingest`, `query`, or `lint` — never synonyms.
  Entry format: `## [YYYY-MM-DD] ingest | <title>`
