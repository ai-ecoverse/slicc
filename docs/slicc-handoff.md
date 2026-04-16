# SLICC Handoff URLs

SLICC can accept a handoff from another agent through a browser tab URL:

```text
https://www.sliccy.ai/handoff#<base64url-json>
https://slicc-tray-hub-staging.minivelos.workers.dev/handoff#<base64url-json>
```

The fragment contains a base64url-encoded UTF-8 JSON payload. The handoff page serves a lightweight preview at `/handoff`, and both the Chrome extension and the standalone app watch for matching tabs. When one is seen, SLICC queues a pending handoff and shows an approval prompt in the Chat tab.

## Payload shape

Required:

- `instruction: string`

Optional:

- `title: string`
- `urls: string[]`
- `context: string`
- `acceptanceCriteria: string[]`
- `notes: string`

Example:

```json
{
  "title": "Verify signup flow",
  "instruction": "Continue this task in SLICC and verify the signup flow works end to end.",
  "urls": ["http://localhost:3000/signup"],
  "context": "The local coding agent already changed the validation and submit flow.",
  "acceptanceCriteria": [
    "The signup form renders",
    "Submitting valid data reaches the success state",
    "No uncaught console errors appear"
  ],
  "notes": "Use the currently signed-in browser session."
}
```

## Local server endpoint

When a SLICC local server is running (Node or Swift backend), agents can POST the payload directly to it to inject the handoff into any running SLICC browser/Electron attached to that server:

```text
POST http://localhost:${SLICC_PORT:-5710}/api/handoff
content-type: application/json

{ "instruction": "...", "title": "...", ... }
```

The server validates that `instruction` is a non-empty string (returning `400 { "error": "instruction is required" }` otherwise), then broadcasts a `handoff_event` over the lick WebSocket. Both Node and Swift backends implement this identically — the helper script fires off this POST in addition to printing the handoff URL, so agents do not need to care which backend is running.

## Helper

Use the helper bundled with the `slicc-handoff` skill:

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff payload.json
```

The helper is a Node script and auto-detects piped stdin:

```bash
cat payload.json | .agents/skills/slicc-handoff/scripts/slicc-handoff
```

Add `--open` to launch the generated URL in the local browser when the host environment supports it. `--stdin` is still accepted as a compatibility alias, but it is no longer required when stdin is piped.
