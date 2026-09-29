---
name: playwright-cli
description: |
  Use this whenever the user asks to browse, navigate, click, fill a form,
  scrape, take a screenshot, or otherwise interact with a web page. SLICC drives
  the browser through the `playwright-cli` shell command (also aliased as
  `playwright` and `puppeteer`). Read this BEFORE running any browser
  automation: every tab-operating command requires a `--tab` target id, and
  multi-agent tab handling has rules you must follow.
allowed-tools: bash
---

# playwright-cli

Every tab command needs `--tab=<targetId>` (from `open` or `tab-list`). Frame ids (from `frames`) go in `--frame=`, never `--tab`.

Loop: `snapshot` → use its refs (`click e5`, `fill e5 "x" --submit`, `select`, `hover`) → snapshot again; refs die after any change.

Cheaper than a full snapshot: `find "text"`, `snapshot --depth=N`, or `eval` for one value. `eval` runs in the page's global scope: wrap code in `{ }` or an IIFE, or use `eval-file <path> --output=<path>`.

Screenshots: `screenshot --filename=<path> [--max-width=N] [--full-page]` (positional = ref, not path). To see one yourself: `open --view <path> --size low|medium|high`; `read_file` can't show images. Images are costly; prefer snapshot/eval.

Coordinates: `mousemove X Y`, `mousedown`, `mouseup`; scroll with `mousewheel 0 600`.

Network: `requests`, then `response-body` (there is no `network`). `open --mobile` gives lighter pages.

Close only tabs you opened. More: `playwright-cli <cmd> --help`.
