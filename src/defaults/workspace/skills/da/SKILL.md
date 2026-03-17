---
name: da
description: Adobe Document Authoring — read, write, preview, and publish EDS pages
allowed-tools: bash
---

# DA (Document Authoring)

Shell command for Adobe Document Authoring. Manages EDS page content.

## Authentication

Run `oauth-token adobe` to authenticate (auto-triggered on first use).
No manual configuration needed — no `da config`, no client IDs, no service tokens.

## Usage

```
da <command> <eds-url-or-path> [options]
```

All commands accept full EDS URLs: `https://main--repo--org.aem.page/path`
Or use `--org`/`--repo` flags with a plain path.

## Commands

- `da list <url>` — List pages in a directory
- `da get <url> [--output <vfs-path>]` — Get page HTML
- `da put <url> <vfs-file>` — Write HTML to DA from a VFS file
- `da preview <url>` — Trigger AEM preview
- `da publish <url>` — Trigger AEM publish
- `da upload <vfs-file> <url>` — Upload a media file to DA
- `da help` — Show usage

## Examples

```bash
da list https://main--myrepo--myorg.aem.page/
da get https://main--myrepo--myorg.aem.page/products/overview
da get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
da put https://main--myrepo--myorg.aem.page/page /workspace/page.html
da preview https://main--myrepo--myorg.aem.page/page
da publish https://main--myrepo--myorg.aem.page/page
da upload /workspace/image.png https://main--myrepo--myorg.aem.page/media_123.png
```
