---
name: aem
description: AEM Edge Delivery Services — read, write, preview, and publish EDS pages
allowed-tools: bash
---

# AEM (Edge Delivery Services)

Shell command for AEM Edge Delivery Services. Manages EDS page content.

## Authentication

Run `oauth-token adobe` to authenticate (auto-triggered on first use).
No manual configuration needed — no client IDs, no service tokens.

## Usage

```
aem <command> <eds-url-or-path> [options]
```

All commands accept full EDS URLs: `https://main--repo--org.aem.page/path`
Or use `--org`/`--repo` flags with a plain path.

## Commands

- `aem list <url>` — List pages in a directory
- `aem get <url> [--output <vfs-path>]` — Get page HTML
- `aem put <url> <vfs-file>` — Write HTML from a VFS file
- `aem preview <url>` — Trigger AEM preview
- `aem publish <url>` — Trigger AEM publish
- `aem upload <vfs-file> <url>` — Upload a media file
- `aem help` — Show usage

## Examples

```bash
aem list https://main--myrepo--myorg.aem.page/
aem get https://main--myrepo--myorg.aem.page/products/overview
aem get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
aem put https://main--myrepo--myorg.aem.page/page /workspace/page.html
aem preview https://main--myrepo--myorg.aem.page/page
aem publish https://main--myrepo--myorg.aem.page/page
aem upload /workspace/image.png https://main--myrepo--myorg.aem.page/media_123.png
```
