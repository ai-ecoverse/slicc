# SLICC Handoff URLs

SLICC can accept a handoff from another local coding agent through a browser tab URL:

```text
https://www.sliccy.ai/handoffs#<base64url-json>
```

The fragment contains a base64url-encoded UTF-8 JSON payload. The Cloudflare worker serves a lightweight preview page at `/handoffs`, and the Chrome extension watches for matching tabs. When it sees one, it queues a pending handoff and shows an approval prompt in the SLICC Chat tab.

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

## Helper

Use the helper bundled with the `slicc-handoff` skill:

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff payload.json
```

Pipe JSON from stdin when that is easier:

```bash
cat payload.json | .agents/skills/slicc-handoff/scripts/slicc-handoff --stdin
```

Add `--open` to launch the generated URL in the local browser when the host environment supports it.
