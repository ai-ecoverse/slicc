---
name: Automation
description: Licks, webhooks, cron tasks, viewing pages/images, screencapture, onboarding
---

# Automation & Environment Guide

## Viewing Pages and Images

**What you CAN see:**

- **`open --view <path>`** — reads an image from VFS and returns it. Works with PNG, JPEG, GIF, WebP, SVG.
- **`playwright-cli screenshot --tab=<id>`** + **`open --view <path>`** — screenshot a tab, then view it.
- **`screencapture`** — capture user's screen via browser screen sharing. `screencapture --view screenshot.png`.
- **`playwright-cli snapshot --tab=<id>`** — accessibility tree (text). Use to verify content without vision.

**What only the human sees:**

- **`serve <dir>`** — opens app directory in browser tab
- **`open <path>`** (no flags) — opens file in browser tab
- **`imgcat <path>`** — displays image in terminal preview

**Workflow to verify a page:**

1. `serve /workspace/app` — open app (human sees it)
2. `playwright-cli tab-list` — find tab by URL, note targetId
3. `playwright-cli snapshot --tab=<id>` — required before screenshot
4. `playwright-cli screenshot --tab=<id> --filename=/tmp/shot.png`
5. `open --view /tmp/shot.png` — now you can see it

**Do NOT:**

- `read_file` on a PNG or base64 encode to view images
- `imgcat` or `cat` on screenshots expecting to see them
- Open a screenshot then screenshot that tab
- Use `eval` to check active tab — use `tab-list`

## Environment Caveats

This is a sandboxed browser-based VFS. Many standard tools don't exist.

- **Serving**: Use `serve` or `open` — no HTTP server needed
- **serve/open already open tabs**: Don't duplicate with `playwright-cli open`. Use `tab-list` to find existing tab.
- **Never manually construct preview URLs** — use URL from command output
- **No long-running servers**: `serve` and `open` handle previewing
- **No package managers**: No `apt`, `npm install`, `pip install`

## Onboarding

When you receive a `[Sprinkle Event: welcome]` with `onboarding-complete`, read `/workspace/skills/welcome/SKILL.md` and follow its instructions.
