---
name: eds
description: Adobe Edge Delivery Services — read, write, preview, and publish EDS pages
allowed-tools: bash
---

# EDS (Edge Delivery Services)

Shell command for Adobe Edge Delivery Services. Manages EDS page content.

## Authentication

Run `oauth-token adobe` to authenticate (auto-triggered on first use).
No manual configuration needed — no client IDs, no service tokens.

## Usage

```
eds <command> <eds-url-or-path> [options]
```

All commands accept full EDS URLs: `https://main--repo--org.aem.page/path`
Or use `--org`/`--repo` flags with a plain path.

## Commands

- `eds list <url>` — List pages in a directory
- `eds get <url> [--output <vfs-path>]` — Get page HTML
- `eds put <url> <vfs-file>` — Write HTML from a VFS file
- `eds preview <url>` — Trigger AEM preview
- `eds publish <url>` — Trigger AEM publish
- `eds upload <vfs-file> <url>` — Upload a media file
- `eds help` — Show usage

## Examples

```bash
eds list https://main--myrepo--myorg.aem.page/
eds get https://main--myrepo--myorg.aem.page/products/overview
eds get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
eds put https://main--myrepo--myorg.aem.page/page /workspace/page.html
eds preview https://main--myrepo--myorg.aem.page/page
eds publish https://main--myrepo--myorg.aem.page/page
eds upload /workspace/image.png https://main--myrepo--myorg.aem.page/media_123.png
```
