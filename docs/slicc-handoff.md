# SLICC Handoff via `Link` headers

SLICC accepts a handoff from another agent (or any external system) through an RFC 8288 `Link` response header on a main-frame navigation. Any page, anywhere, can opt in — there is no allow-list.

## Mechanism

1. A tab navigates to a URL whose main-frame document response carries a `Link` header advertising one of SLICC's recognised rels:

   ```http
   Link: <>; rel="https://www.sliccy.ai/rel/handoff";
         title*=UTF-8''Continue%20the%20signup%20flow
   ```

   or:

   ```http
   Link: <https://github.com/slicc/skills-extra>; rel="https://www.sliccy.ai/rel/upskill"
   ```

2. SLICC observes the response header (via a CDP `Network.responseReceived` watcher in CLI/Electron floats, or `chrome.webRequest.onHeadersReceived` in the extension float), parses every `Link` value with the shared parser, and emits a `navigate` lick event carrying `{ url, verb, target, instruction?, title? }`.
3. The cone shows a yes/no approval card quoting the origin URL, verb, target, and instruction.
4. On accept, the cone dispatches by verb.

The verb is the rel; the target is the link href; the prose instruction (handoff verb only) rides in the link's `title` parameter (RFC 8187 `title*=UTF-8''…` for non-ASCII).

### Profile-independent fallback

The CDP watcher only sees tabs in the Chrome instance SLICC launched (an isolated profile keyed by port); the extension's `webRequest` listener only fires inside the profile where it is installed. Tools running outside that profile — most CLI helpers, other coding agents, Claude Code — would miss the navigation entirely.

To bridge this, the node-server exposes a POST endpoint:

```http
POST http://localhost:${SLICC_PORT ?? 5710}/api/handoff
Content-Type: application/json

{
  "verb": "handoff" | "upskill",
  "target": "<absolute URL>",
  "instruction": "<optional free-form prose>",
  "url": "<origin>",
  "title": "<optional>"
}
```

The handler broadcasts a `navigate_event` over the lick WebSocket, which the webapp turns into the same navigate lick the CDP watcher would emit. External tools should post here alongside (or instead of) opening the URL.

The legacy `{ sliccHeader: "verb:payload" }` payload is rejected with a 400 — clients must build the structured form.

## Recognised rels

- `https://www.sliccy.ai/rel/handoff` — free-form handoff. The link target is the page itself (`<>` self-anchor); the prose instruction rides in `title` / `title*`.
- `https://www.sliccy.ai/rel/upskill` — install a skill from a public GitHub repo. The link target is the GitHub repo URL.

Both URIs resolve to documentation pages served by the worker at `https://www.sliccy.ai/rel/handoff` and `/rel/upskill` (per RFC 8288 §2.1.2).

Unknown rels are ignored — SLICC dispatches by exact rel match only.

## Convenience endpoint

The tray-hub worker at `https://www.sliccy.ai/handoff` echoes payloads into a `Link` response header. Three query forms are accepted:

- `?upskill=<github-url>` → emits `Link: <github-url>; rel="https://www.sliccy.ai/rel/upskill"`
- `?handoff=<text>` → emits `Link: <>; rel="https://www.sliccy.ai/rel/handoff"; title*=UTF-8''<percent-encoded text>`
- `?msg=verb:payload` (legacy) → server-side colon-prefix split into the same `Link` form

External tools that want to trigger a handoff without hosting their own page can point users at one of these URLs.

## Helper script

`.agents/skills/slicc-handoff/scripts/slicc-handoff` builds the URL for you:

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "Continue the signup flow"
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "upskill:https://github.com/slicc/skills-extra"
```

If the instruction does not start with a known verb, the helper treats it as a `handoff:` instruction. The script also POSTs the structured payload to `/api/handoff` so the local SLICC server picks it up regardless of which browser profile the user is currently driving.

## Discoverable surface

Every SLICC HTTP response also carries the standard discovery rels described in [link-discovery.md](./link-discovery.md): `api-catalog`, `service-desc`, `service-doc`, `https://llmstxt.org/rel/llms-txt`, `terms-of-service`. The handoff rels are payload-bearing and only appear on `/handoff` responses; the standard discovery rels appear on every response.
