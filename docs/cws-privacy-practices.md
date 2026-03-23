# CWS Privacy Practices Form Answers

Answers for the Chrome Web Store Developer Dashboard **Privacy** tab.
Each section maps to a specific form field or checkbox group.

---

## Single Purpose Description

slicc is an AI coding agent that runs in the Chrome side panel. Its single purpose is to assist developers with web development tasks: editing files, running shell commands, and automating browser interactions — all in response to developer instructions, within the developer's own browser session.

---

## Data Use Disclosures

### Are you using any of the following data types?

The following checkboxes should be marked **Yes** with the explanations below.

#### Web Browsing Activity — YES (conditional)

The extension accesses browser tab URLs and page content only during active browser automation sessions. This occurs only when the developer explicitly asks the agent to interact with a specific tab (e.g., "take a screenshot of this page" or "click the submit button"). Tab content seen during automation is forwarded to the developer's configured LLM provider to complete the task. The extension does not monitor browsing activity passively or outside of explicit automation requests.

#### Website Content — YES (conditional)

Page content (DOM structure, text, screenshots) is captured from tabs during browser automation sessions. This data is sent to the developer's configured LLM API endpoint to enable the agent to understand and interact with the page. Content is not stored beyond the current conversation context and is not transmitted to any slicc server.

#### Authentication Information — YES (local storage only)

LLM API keys entered by the developer are stored in the extension's isolated localStorage. These keys are used solely to authenticate requests to the developer's chosen LLM provider. They are never transmitted to any slicc server and are not shared with any third party beyond the provider the developer has configured.

#### Personal Communications — YES (local storage only)

Chat messages between the developer and the AI agent are stored in IndexedDB within the extension's isolated storage. These conversations are transmitted to the developer's configured LLM provider to generate responses. They are not transmitted to any slicc server and are not shared with any third party beyond the developer's chosen LLM provider.

---

### Data types that are NOT collected

The following data types are **not** collected by slicc:

- Personally identifiable information (name, address, email, phone)
- Health or financial information
- Location data
- User activity across sites not explicitly opened during agent automation
- User-generated content beyond the agent chat and virtual filesystem

---

## Certifications

The following statements apply to slicc and should be certified on the form:

- **No selling**: We do not sell user data to third parties.
- **No unrelated use**: Data is not used for purposes unrelated to the extension's single purpose (AI-assisted web development). Data is not used for advertising, profiling, or analytics unrelated to extension functionality.
- **No creditworthiness use**: Data is not used to determine creditworthiness or for lending purposes.

---

## Telemetry Disclosure

slicc may collect anonymous usage telemetry via Adobe RUM when the developer explicitly opts in. This is disclosed at first run via a consent dialog.

**If telemetry is enabled by the developer:**

- Data collected: feature usage events (tool names, command types), error types, extension version, Chrome version
- Data not collected: message content, file contents, API keys, URLs of visited pages, any personally identifiable information
- Data is sent to Adobe RUM infrastructure using HTTPS
- The developer can opt out at any time via extension settings

**Telemetry is disabled by default.** No telemetry data is collected without explicit opt-in consent.
