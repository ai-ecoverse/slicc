# CWS Permission Justifications

Text for the Chrome Web Store Developer Dashboard permission justification fields.
Paste each section into the corresponding field when submitting the extension.

---

## `debugger`

slicc is an AI coding agent that automates browser interactions on behalf of the developer. The `debugger` permission is the core mechanism for this automation: it enables the agent to navigate to URLs, capture screenshots of the current page state, click elements, fill forms, and evaluate JavaScript — all in response to developer instructions. This is the same capability used by tools like Puppeteer and Playwright. The permission is requested at runtime the first time the agent needs to interact with a tab, not on extension install. Chrome's standard yellow "debugging" bar is displayed on every attached tab so the user always knows when automation is active. The extension attaches only to tabs explicitly selected by the user and detaches as soon as the task is complete.

---

## `tabs`

The `tabs` permission is required to enumerate open browser tabs so the developer can select which tab the agent should interact with during an automation task. When a developer asks the agent to "work with the current page" or "test this site," the extension needs the complete tab list to present a target picker and to resolve the currently active tab. Tab metadata (titles, URLs) is used solely for this selection UI and is never stored or transmitted.

---

## `tabGroups`

When the agent opens new browser tabs during a task (for example, opening a staging URL to test a change), it groups those tabs into a labeled "slicc" group with a distinct color. This uses the `tabGroups` permission. Grouping keeps the developer's workspace organized and makes it easy to identify which tabs were created by the agent versus opened manually. No tab group data is stored or transmitted.

---

## `optional_host_permissions: <all_urls>`

The `<all_urls>` permission is declared as optional and is never granted on install. It is requested at runtime only when the agent needs to access a specific URL — for example, to call a configured LLM API endpoint, fetch web resources during research, or perform git clone/push/pull operations on behalf of the developer. Developers building web applications may work with arbitrary domains (local dev servers, staging environments, third-party APIs), so the permission cannot be scoped to a fixed list at install time. When requested, Chrome displays its standard permission consent dialog listing the exact scope. The developer can revoke this permission at any time via Chrome's extension settings.

---

## `sidePanel`

slicc's entire user interface — the chat panel, file browser, terminal, and agent controls — is rendered in Chrome's side panel. The `sidePanel` permission is required to register and display this UI. There is no alternative surface that would provide the persistent, non-intrusive workspace the extension requires for a coding assistant that runs alongside the developer's active tabs.

---

## `offscreen`

The AI agent engine runs in an offscreen document so it continues processing tasks when the developer closes the side panel. Without this, closing the panel would interrupt long-running agent operations (file edits, multi-step browser automation, test runs). The offscreen document uses the `WORKERS` justification — it hosts the agent loop, shell execution environment, and virtual filesystem, which are background computation workloads with no visible UI. The offscreen document does not access audio, video, or any media capture APIs.

---

## `identity`

Some LLM providers support OAuth-based authentication instead of static API keys (for example, signing in with a Google account to access a provider's API). The `identity` permission enables `chrome.identity.launchWebAuthFlow()` for these flows. Without it, users of OAuth-enabled providers cannot authenticate. The permission is used only during explicit sign-in actions initiated by the user; the extension does not access Chrome's cached OAuth tokens for any other purpose.
