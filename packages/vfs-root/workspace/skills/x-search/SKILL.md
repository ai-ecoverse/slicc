---
name: x-search
description: |
  Search X (formerly Twitter) for real-time posts, sentiment, and citations
  via xAI's `x_search` server-side tool. Works with any model — the search
  call runs through your xAI Grok OAuth credentials regardless of which
  model is steering the cone. Use when you need fresh social-media signal,
  public reactions, or to find specific posts by keyword, hashtag, or handle.
allowed-tools: bash
---

# X Search

Run `x_search` from bash. The script pipes a one-shot request to xAI's
Responses API with the `x_search` server tool enabled, then prints the
model's answer plus any citation URLs.

## Authentication

The shell command resolves the bearer token through `oauth-token xai-grok`,
so you must be signed in to xAI Grok first:

```bash
oauth-token xai-grok
```

If the command prints `xai-grok: not signed in`, run `/login` in the side
panel (or the same `oauth-token xai-grok` interactively) to complete the
xAI OAuth flow before searching.

## Usage

```bash
# Free-form query — most common usage
x_search "what are people saying about Grok 4.3?"

# Restrict to specific handles (comma-separated, max 10)
x_search --from "elonmusk,xai" "ship dates for Grok"

# Date range (ISO 8601)
x_search --since 2025-01-01 --until 2025-03-31 "earnings call reactions"

# Pin the underlying search model (default: grok-4.3)
PI_XAI_X_SEARCH_MODEL=grok-4.5 x_search "fed minutes hot takes"
```

## Output

Plain text answer followed by citations:

```text
Recent posts indicate broadly positive sentiment …

Sources:
- https://x.com/user/status/...
- https://x.com/user/status/...
```

## Notes

- `x_search` is a separate xAI request, not a context-bearing tool call. The
  result is folded into your transcript as a bash result, so you can quote
  or summarize it directly.
- Per-request `enable_image_understanding` / `enable_video_understanding`
  toggles are intentionally not exposed; xAI's defaults are sensible and the
  toggles bloat the response.
- This skill is a slicc-native shell command — `pi.registerTool` does not
  apply here. The behavior matches stnly/pi-grok's `x_search` tool.
