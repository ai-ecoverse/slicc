# CWS Store Listing

Content and asset checklist for the Chrome Web Store Developer Dashboard listing page.

---

## Category

**Developer Tools**

---

## Short Description

132 characters max. Copy from manifest `description` field:

> AI coding agent in your browser side panel — automates tabs, edits files, and runs shell commands for web development

_(118 characters — within limit)_

---

## Detailed Description

Target: 300–500 words. Paste into the "Detailed description" field on the store listing.

---

**slicc** is an AI coding agent that lives in your Chrome side panel and helps you build web projects — without switching context away from your browser.

Tell slicc what you want to do in plain English. It reads and edits files, runs shell commands, and automates the browser tabs you already have open. When a task is done, results appear in the chat. You stay in the browser.

**How it works**

1. **Open the side panel.** Click the slicc icon to open the agent in Chrome's side panel alongside any page you're working on.
2. **Describe your task.** Type what you need — "fix the CSS alignment on this page," "run the tests and show me failures," "git commit these changes with a sensible message."
3. **The agent does the work.** slicc reads your project files, runs shell commands (bash, git, node, python), and can interact with browser tabs — navigating, clicking, taking screenshots — to verify changes as it makes them.

**What slicc can do**

- Read and edit files in your project's virtual filesystem
- Run bash, git, node, and Python commands via a WASM shell
- Navigate browser tabs, take screenshots, click elements, and evaluate JavaScript for browser automation
- Spawn isolated sub-agents ("scoops") for parallel tasks
- Install and use skills — composable Markdown-based prompts that extend the agent's capabilities for specific workflows

**Privacy-first design**

slicc stores all your data locally. Conversations, files, and settings stay in your browser's IndexedDB and localStorage — no slicc server ever sees them. When you send a message, it goes directly from your browser to the LLM API endpoint you configure (Anthropic Claude, OpenAI, or any compatible provider). You hold your own API keys.

Browser tab access is optional: the `debugger` permission is only requested when you ask the agent to interact with a tab. Chrome shows its standard yellow debugging bar on any attached tab. You can revoke this permission at any time.

Optional anonymous telemetry is off by default. If you opt in, only feature usage counts and error types are collected — never message content, file contents, or API keys.

**Built for developers**

slicc is designed for developers who want an agent that works the way they think: composing shell commands, manipulating files, and driving a browser — not a chatbot with a list of integrations. The shell is the interface; the browser is the canvas.

---

## Visual Assets Checklist

### Required

- [ ] **Store icon** — 128×128 PNG (use `logos/slicc-favicon-128.png`)
- [ ] **Screenshots** — at least 1, up to 5; 1280×800 or 640×400 PNG/JPEG

### Recommended screenshots to capture

| # | Scene | Notes |
|---|-------|-------|
| 1 | Agent chat + side panel open on a code page | Shows primary use case |
| 2 | File browser with virtual filesystem | Shows project file management |
| 3 | Browser automation in action (yellow bar + agent message) | Justifies `debugger` permission visually |
| 4 | Terminal tab showing bash/git output | Shows shell capability |
| 5 | Permission consent dialog for `<all_urls>` | Demonstrates transparent runtime consent |

### Optional

- [ ] **Promotional tile** — 440×280 PNG (small promo)
- [ ] **Marquee promo tile** — 1400×560 PNG (large promo, needed for featuring)

Use `hero-banner.png` at the repo root as a starting point for promotional tiles.
