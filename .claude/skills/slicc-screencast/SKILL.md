---
name: slicc-screencast
description: |
  Record a CDP screencast of the *running* SLICC dev-harness UI to see what
  changed in a PR. Connects over Chrome DevTools Protocol to the leader tab the
  dev/e2e harness already drives (no separate browser context), streams frames
  to disk, and optionally stitches them into a webm. Use when you want to review
  UI changes frame-by-frame, capture a before/after for a PR, or record the
  deterministic fake-LLM e2e scenario. For a polished, cursor-animated MP4 demo,
  use the `demo-recording` skill instead.
globs: 'packages/webcomponents/**,packages/webapp/src/ui/**'
---

# SLICC screencast (CDP frame capture)

`packages/dev-tools/tools/slicc-screencast.mjs` attaches to Chrome's remote
debugging port, locks onto the SLICC leader page target, and streams
`Page.startScreencast` frames to disk as `frame-000001.jpeg …` plus a
`manifest.json` (real capture timestamps). It records the **same** Chrome the
harness already uses — so you review exactly what the harness rendered. It is a
host-side node tool (like `slicc-debug.mjs`), not a SLICC shell command.

## When to use which recorder

- **`slicc-screencast`** (this skill) — CDP frames of the live/e2e harness tab.
  Fast, no extra browser, source-of-truth frames for "what changed". Optional
  best-effort webm.
- **`demo-recording`** — Playwright `video-start`/`video-stop` with an animated
  cursor and chapter markers, post-processed into a GitHub-embeddable MP4. Use
  for showcase demos.

## Quick start (against the deterministic fake-LLM e2e harness)

The e2e harness (`packages/webapp/tests/e2e/playwright.config.ts`) boots wrangler
(UI on `:8787`), the node-server thin-bridge, and the fake LLM, and launches
Chrome with `--remote-debugging-port=9222`. Reuse it to get a reproducible run:

```bash
# 0. one-time in a fresh VM: system libs for Chrome + ffmpeg
npx playwright install chromium && npx playwright install-deps chromium

# 1. start the recorder against the harness Chrome, locked to the leader tab
node packages/dev-tools/tools/slicc-screencast.mjs \
  --port 9222 --url localhost:8787 --out /tmp/shot --video &

# 2. drive the UI (see below), then stop the recorder
kill -INT %1            # flushes manifest.json (+ screencast.webm if --video)
```

Frames + `manifest.json` land in `--out`. Review them directly (open a few
`frame-*.jpeg`), or watch `screencast.webm`.

## Driving the UI while recording

Pick whichever fits — the recorder just captures whatever the tab shows:

- **`slicc-debug.mjs`** (host, over the same CDP port) — drive the agent/shell:
  `node packages/dev-tools/tools/slicc-debug.mjs chat "open the reference page"`
  or `… shell "playwright-cli ..."`.
- **A Playwright e2e test** — the deterministic path. Boot the leader with the
  harness helpers (`seedLocalLlmProvider` → `gotoLeader` → `waitForSW`), then
  `submitUserMessage(page, …)` + `waitForTurnComplete(page)` per phase. Spawn the
  recorder as a child against `:9222` for a fully reproducible capture.
- **By hand** — just interact in the visible Chrome window.

## Live dev harness (non-e2e)

The recorder works against any SLICC Chrome with remote debugging — e.g.
`npm run dev` or `npm run dev:standalone:fresh` (wrangler `:8787` + thin-bridge
`:5710`, Chrome CDP `:9222`). Same command; `--port`/`SLICC_CDP_PORT` and
`--url`/`SLICC_TARGET_URL` select the port and page target.

## Options

| Flag                                    | Default                         | Purpose                    |
| --------------------------------------- | ------------------------------- | -------------------------- |
| `--out <dir>`                           | `/tmp/slicc-screencast/<stamp>` | Frame output directory     |
| `--port <n>`                            | `SLICC_CDP_PORT` else 9222/9223 | Chrome CDP port            |
| `--url <substr>` / `--url-pattern <re>` | `SLICC_TARGET_URL`              | Pick the page target       |
| `--duration <sec>`                      | until SIGINT                    | Auto-stop after N seconds  |
| `--format jpeg\|png`                    | `jpeg`                          | Frame image format         |
| `--quality <0-100>`                     | `80`                            | JPEG quality               |
| `--max-width/--max-height <px>`         | `1280` / `800`                  | Frame bounds               |
| `--every-nth <n>`                       | `1`                             | Capture every Nth frame    |
| `--video` / `--fps <n>`                 | off / `10`                      | Assemble `screencast.webm` |

## Video assembly (best-effort)

The frames + `manifest.json` are the source of truth; `--video` is a
convenience. `slicc-screencast-video.mjs` resolves ffmpeg from PATH, falling
back to Playwright's bundled ffmpeg. That bundled build is stripped — it has no
`image2` demuxer and only the VP8 encoder — so assembly feeds frames via
`image2pipe` on stdin (`-c:v mjpeg -i pipe:0`) and writes VP8 **webm**. On a full
ffmpeg build it also produces mp4/gif. If assembly fails, the frames remain.

## Reviewing + embedding in a PR

- Review: open `frame-000001.jpeg …`, or scrub `screencast.webm`.
- GitHub PR embed: GitHub auto-embeds an uploaded `.mp4`/`.webm` dragged into the
  PR description on github.com (no programmatic upload path — the
  `user-attachments` endpoint needs a browser session). For a polished MP4, hand
  off to `demo-recording`.
