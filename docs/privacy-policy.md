# Privacy Policy — slicc

**Effective date:** 2026-03-19

slicc is a Chrome extension that runs an AI coding agent in your browser side panel. This policy explains what data the extension collects, where it goes, and how you control it.

---

## Data Stored on Your Device

All primary state is stored locally in your browser using Chrome's extension-isolated storage. No slicc server receives or retains this data.

| Data | Storage location | Leaves device? |
|------|-----------------|---------------|
| Chat conversation history | IndexedDB | Only when sent to your LLM provider (see below) |
| Virtual filesystem contents | IndexedDB | No |
| LLM API keys and provider settings | localStorage (extension storage) | No |
| Agent memory and skill files | IndexedDB | No |

**API keys** are stored in the extension's isolated localStorage. They are never transmitted to any slicc server. They are sent directly to the LLM API endpoint you have configured (e.g., Anthropic, OpenAI, Azure AI).

---

## Data Sent to Third Parties

### Your LLM Provider

When you submit a message to the agent, slicc sends your conversation history to the LLM API endpoint you have configured. This includes:

- Your chat messages and the agent's replies
- File contents passed to the agent via tools (read_file, edit_file)
- Browser tab content captured during web automation sessions (if you have granted the browser access permission and the agent reads a tab)

**You choose the provider.** slicc does not dictate which LLM you use or have any relationship with your provider. Review your provider's privacy policy for their data handling practices.

### Anonymous Telemetry (opt-in only)

In extension mode, slicc may collect anonymous usage telemetry via Adobe RUM (Real User Monitoring). This telemetry is **opt-in only** — it is not enabled by default and requires your explicit consent.

If you opt in, the following may be collected:

- Feature usage events (e.g., "agent started", "tool used", "permission granted")
- Error types and frequency (no stack traces or personal data)
- Extension version and Chrome version

Telemetry does **not** include:

- Chat messages or conversation content
- File contents
- API keys or credentials
- URLs of tabs you visit
- Any personally identifiable information

---

## Browser Tab Access

slicc can interact with browser tabs for web development automation (navigation, screenshots, JavaScript evaluation, clicking). This capability is **optional** and requires a runtime permission grant.

- The `debugger` permission is requested when you first ask the agent to interact with a browser tab
- You will see Chrome's standard yellow "debugging" bar on any tab the extension is attached to
- Tab content seen during automation is sent only to your configured LLM provider, not to any slicc server
- slicc does not use content scripts and does not inject code into pages you browse normally

---

## Permissions Explained

| Permission | Purpose |
|-----------|---------|
| `debugger` | Browser automation — navigate pages, take screenshots, click elements, evaluate JavaScript in developer tabs |
| `tabs` | List open tabs so you can select which tab the agent should interact with |
| `tabGroups` | Group agent-created tabs into a labeled "slicc" group with a distinct color |
| `sidePanel` | Render the agent UI in Chrome's side panel |
| `offscreen` | Keep the agent engine running when you close the side panel |
| `identity` | OAuth authentication flows for LLM providers (e.g., sign in with Google for supported providers) |
| `<all_urls>` (optional) | Requested at runtime when needed — allows the agent to fetch web resources, call LLM API endpoints, and perform git operations on your behalf |

---

## Data Security

- All communication with LLM providers and external services uses HTTPS
- API keys are stored in Chrome's extension-isolated storage, inaccessible to websites you visit
- The extension has no backend server that stores your data
- Sandbox pages (`sandbox.html`, `sprinkle-sandbox.html`) enforce strict Content Security Policy to prevent code injection

---

## User Controls

- **Delete conversation history**: Use the clear/reset function in the chat panel to wipe IndexedDB
- **Remove API keys**: Clear extension storage via the extension settings or by uninstalling the extension
- **Revoke tab access**: Remove the `debugger` permission via Chrome's extension settings at any time
- **Revoke web access**: Remove the `<all_urls>` optional permission via Chrome's extension settings
- **Opt out of telemetry**: Decline the telemetry consent prompt, or disable it in extension settings if you previously opted in
- **Uninstall**: Removing the extension from Chrome deletes all locally stored data

---

## Contact

For privacy questions or concerns, open an issue at:
[https://github.com/ai-ecoverse/slicc](https://github.com/ai-ecoverse/slicc)

_This policy may be updated as the extension evolves. The effective date at the top of this document reflects the most recent revision._
