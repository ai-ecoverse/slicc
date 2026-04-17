# SLICC Handoff via `x-slicc`

SLICC accepts a handoff from another agent (or any external system) through the `x-slicc` response header on a main-frame navigation. Any page, anywhere, can opt in — there is no allow-list.

## Mechanism

1. A tab navigates to a URL whose main-frame document response carries the header:

   ```text
   x-slicc: <verb>:<payload>
   ```

2. SLICC observes the header (via a CDP `Network.responseReceived` watcher in CLI/Electron floats, or `chrome.webRequest.onHeadersReceived` in the extension float) and emits a `navigate` lick event carrying `{ url, sliccHeader, title? }`.
3. The cone shows a yes/no approval card quoting the origin URL and the header value.
4. On accept, the cone dispatches by verb prefix.

## Verb prefixes

- `handoff:<free-form instruction>` — cone fetches the page body (`curl <url>`) and acts on whatever it finds there alongside the instruction.
- `upskill:<github-url>` — cone confirms, then runs `upskill <github-url>` to install the skill.

Unknown prefixes are treated as free-form — the cone asks the user what to do with them.

## Convenience endpoint

The tray-hub worker at `https://www.sliccy.ai/handoff?msg=<urlencoded>` echoes the `msg` query parameter into an `x-slicc` response header. External tools that want to trigger a handoff without hosting their own page can point users at that URL.

## Helper script

`.agents/skills/slicc-handoff/scripts/slicc-handoff` builds the URL for you:

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "Continue the signup flow"
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "upskill:https://github.com/slicc/skills-extra"
```

If the instruction does not start with a known verb, the helper prepends `handoff:`.
