---
name: playwright-cli-e2e
description: |
  Use this when you need to test or QA the `playwright-cli` browser-automation
  command, re-run the browser-automation test session, check playwright-cli for
  regressions, or verify that browser automation still works after a change.
  Covers a repeatable 12-group e2e session: a `pcli-e2e` runner that automates the
  deterministic groups and diffs against a known PASS/FAIL baseline, a reusable
  HTML test fixture, and a manual checklist for the visual/interactive groups.
  For everyday browsing/scraping (not regression testing) use the `playwright-cli`
  skill instead.
allowed-tools: bash, read_file, write_file
---

# playwright-cli E2E regression session

Re-run a consistent, 12-group end-to-end exercise of the `playwright-cli` shell command and diff the result against a known-good baseline to catch regressions and confirm bug fixes.

## How to run it

1. **Automated, deterministic groups** — run the companion runner:
   ```bash
   pcli-e2e            # runs the checks, prints a PASS/FAIL table + JSON, cleans up its tab
   pcli-e2e --help
   ```
   It loads `test-fixture.html` (this directory) as a `data:` URL, exercises each programmatically-checkable group, and flags every result as **matches baseline**, **REGRESSION** (was PASS, now FAIL), or **IMPROVEMENT** (was a known bug, now PASS). The final line is a machine-comparable JSON object.
2. **Manual / visual groups** — work the checklist below by hand. These need human or visual judgment (mouse feel, overlay rendering, HAR file contents, live dialogs) and are deliberately **not** automated.
3. **Save the run** next to the original report, dated: `/shared/playwright-cli-e2e-report-<YYYY-MM-DD>.md`. Reference report: `/shared/playwright-cli-e2e-report.md`.

## The 12 test groups

| #   | Group            | Auto?              | Key commands to exercise                                                                    | PASS looks like                                                                                           |
| --- | ---------------- | ------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Core             | manual             | `open`/`goto`, `snapshot`, `eval`, `frames`, `resize`, `reload`                             | snapshot lists refs; `eval "document.title"` returns the title; resize/reload ack                         |
| 2   | Interaction      | partial            | `fill`, `type`, `press`, `click`, `hover`, `select`, `check`, `uncheck`, `dblclick`, `drag` | input value/`#out` attrs change; `select`/`check`/`hover` resolve the ref (auto: ref-resolution detector) |
| 3   | Network capture  | **auto**           | `requests`, `request N`, `request-headers`, `response-headers`, `response-body`             | `requests` lists entries on a real navigation; detail sub-commands return data                            |
| 4   | Console          | **auto**           | `eval` log/warn/error, `console [min-level]`, `console --clear`                             | logged messages appear; `--clear` empties the buffer                                                      |
| 5   | Route mocking    | **auto**           | `route`, `route-list`, page `fetch`, `unroute`                                              | mocked body is returned by the page fetch; `unroute` clears routes                                        |
| 6   | Mouse            | manual             | `mousemove`, `mousedown`, `mouseup`, `mousewheel`                                           | each acks; `#out` `data-scroll` updates on wheel (note: `mousewheel` is flaky)                            |
| 7   | Visual / locator | **auto** (locator) | `generate-locator`, `highlight [--hide]`                                                    | generated selector actually matches an element; highlight overlay appears/clears                          |
| 8   | Drop             | manual             | `drop --data=mime/type=value`, `drop --path=<vfs>`                                          | `#dropout` == `dropped:<value>`; `#fileout` == `file:<name>`                                              |
| 9   | Storage          | manual             | `cookie-*`, `localstorage-*`, `sessionstorage-*` (use a real origin)                        | full CRUD round-trips on a real origin (opaque `data:` origins won't store)                               |
| 10  | Screenshots      | **auto**           | `screenshot`, `--filename`, `--fullPage`, `--max-width`, element ref                        | option variants produce **different** dimensions/bytes (auto: byte+IHDR detector)                         |
| 11  | HAR              | manual             | `record <url>`, `stop-recording <id>`                                                       | commands succeed; HAR saved under `/recordings/...` (contents not VFS-visible)                            |
| 12  | fetch / discover | **auto**           | `fetch <url>`, `fetch <url> --discover`                                                     | JSON with `status`, `links[]`, and a `discovery` object                                                   |

## The reusable test fixture

`test-fixture.html` (this directory) is a self-contained page (no external resources) with: `#title` heading, `#name` text input (aria-label "Your name"), `#notes` textarea, `#color` select (red/green/blue), `#agree` checkbox, two `name=opt` radios, a text-named `#btn` ("Click me" → sets `#out` to `clicked`), draggable `#dragsrc`, a data-transfer `#dropzone` (→ `#dropout`), a file `#filezone` (→ `#fileout`), a 2000px `#scrollbox`, and keydown/scroll listeners that stamp `#out` with `data-key` / `data-scroll`.

aria-labels are intentional: `#name`/`#color`/`#agree` have accessible names from attributes, while `#btn`/`#dragsrc` are **text-named** — that contrast is what probes the locator/ref bugs.

**Load it as a `data:` URL, not a VFS path** (`open <vfs-path>` renders about:blank — see Don't). The runner does this for you: it reads the file, base64-encodes it, and `open`s `data:text/html;base64,<...>`.

## Known baseline (2026-06-26) — diff against this

**All 7 automated checks PASS:** Route mocking, Console, Network capture, fetch/discover, Screenshots, Ref resolution, generate-locator.

**Previously-known bugs (fixed in PR #1130):**

1. ~~Ref resolution~~ — fixed: `autoSaveSnapshot` now populates in-memory state after click.
2. ~~generate-locator~~ — fixed: `backendNodeId` populated from CDP Accessibility domain.
3. ~~Screenshots options ignored~~ — fixed: `fullPage`/`maxWidth`/`clip` failures now surface warnings.

**Minor:** `mousewheel` intermittently times out (CDP) then succeeds on retry; `record` prints `recordingId:` inline (easy to mis-parse); HAR `/recordings/...` isn't visible from a scoop's VFS; dialogs auto-dismiss before `dialog-accept` can fire.

Interpreting a new run: a previously-PASS group now FAILing = a **REGRESSION** — investigate and flag it.

## Tab hygiene policy

- Capture the `targetId` from every `open`/`tab-new` you issue; operate only on those.
- **Never close a tab you didn't open** — `tab-list` is shared across all agents and shows the user's tabs and a pre-existing "Test Page" harness. Leave them.
- Clean up at the end: close every tab you opened (the runner closes its own). Handle "tab not found" gracefully — another agent may have closed it.

## Don't

- Don't trust screenshot dimensions from a flooded `hexdump`/`xxd` of the PNG — read the **IHDR** width/height directly (bytes 16–23, big-endian, after the 8-byte signature). The runner does this; if you check by hand, do the same.
- Don't rely on `open <vfs-path>` — it renders `about:blank`. Use a `data:text/html;base64,...` URL.
- Don't run interaction commands against stale refs — `select`/`check`/`drag` need a **fresh** snapshot (and even then ref resolution is the known bug, not your mistake).
- Don't `open --view` the screenshots just to compare them — that burns context; compare md5 + IHDR bytes instead.
- Don't test Storage on a `data:` URL — opaque origins won't persist cookies/localStorage. Use a real origin.
- Don't mark a flaky `mousewheel` timeout as a hard FAIL — retry once before recording it.
