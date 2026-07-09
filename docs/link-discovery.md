# Link header discovery (RFC 8288 / RFC 9727)

SLICC parses `Link` (RFC 8288) headers on every response a scoop fetches, and emits `Link` headers on every response it serves. The parser, discoverer, and emitters are reusable across the worker, the node-server, the webapp, and the chrome extension.

## Modules

| Path                                            | Purpose                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/src/net/link-header.ts`        | Pure RFC 8288 parser + builder. Handles comma-split inside quoted strings, multi-instance merge, RFC 8187 `param*=UTF-8''…` ext-values, and anchor/href URI resolution. |
| `packages/webapp/src/net/discover-links.ts`     | Async P0 discovery: fetches `api-catalog`, `service-desc`, `service-meta`, `status`, `llms-txt`. Per-link timeout + `failures[]` collector.                             |
| `packages/webapp/src/net/handoff-link.ts`       | SLICC verb-dispatch wrapper around the parser. Returns `{ verb, target, instruction?, branch?, path? } \| null` (branch/path are upskill-only).                         |
| `packages/cloudflare-worker/src/links.ts`       | `applySliccLinks()` — appends the standard rel set on every worker response.                                                                                            |
| `packages/cloudflare-worker/src/api-catalog.ts` | RFC 9727 / RFC 9264 linkset of every public route on the worker.                                                                                                        |
| `packages/cloudflare-worker/src/llms-txt.ts`    | llmstxt.org markdown digest.                                                                                                                                            |
| `packages/cloudflare-worker/src/rel-docs.ts`    | Tiny HTML pages for the SLICC custom rel URIs (per RFC 8288 §2.1.2 best practice).                                                                                      |
| `packages/node-server/src/links-middleware.ts`  | Express middleware: appends the standard rel set on every `/api/*` response. Ships `buildLocalApiDescriptor()` for the localhost `GET /api` route.                      |

## Recognised rels

### Standard (parsed and acted on by `discoverLinks`)

| Rel                                | Spec        | What SLICC does with it                                                            |
| ---------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `api-catalog`                      | RFC 9727    | Fetches and JSON-parses; surfaces as `discovery.catalog`.                          |
| `service-desc`                     | RFC 8631    | Fetches; JSON when content-type indicates, else raw text. `discovery.serviceDesc`. |
| `service-meta`                     | RFC 8631    | Same shape; `discovery.serviceMeta`.                                               |
| `status`                           | RFC 8631    | Same shape; `discovery.status`.                                                    |
| `https://llmstxt.org/rel/llms-txt` | llmstxt.org | Fetches as text; `discovery.llmsTxt`.                                              |

### SLICC-specific (custom URIs under `https://www.sliccy.ai/rel/`)

| Rel                                 | Replaces                               | Anchor / payload                                     |
| ----------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| `https://www.sliccy.ai/rel/handoff` | the legacy `x-slicc: handoff:…` header | href = `<>` (self), instruction in `title*=UTF-8''…` |
| `https://www.sliccy.ai/rel/upskill` | the legacy `x-slicc: upskill:…` header | href = github URL of the skill                       |

Custom rels are case-sensitive URIs and dereference to short HTML docs at `https://www.sliccy.ai/rel/<name>`.

### Upskill `branch` / `path` Link params

The upskill rel accepts two optional Link params that scope the install without forcing the emitter to construct a `tree/<branch>/<subpath>` GitHub URL:

```http
Link: <https://github.com/owner/repo>; rel="https://www.sliccy.ai/rel/upskill"; branch=main; path="skills/foo"
```

- `branch` — git ref to install from. Plain ASCII form (`branch=main`) is preferred; RFC 8187 ext-value form (`branch*=UTF-8''feature%2F%C3%A9`) is accepted for non-ASCII names.
- `path` — sub-path under the repo root containing the skill. A trailing `/SKILL.md` (case-insensitive) is stripped so the canonical form is the containing directory, matching the rest of the install pipeline.
- Either may be absent; when both are present, the cone is expected to install only the named sub-path on the named branch.
- Both params are **upskill-only**. The handoff rel ignores them at the extractor, and the manual `POST /api/handoff` endpoint rejects the combination with a 400.

These params flow end-to-end: `extractHandoff` surfaces them, the CDP `NavigationWatcher` and `chrome.webRequest` observer carry them, the `navigate` lick body exposes them to the cone, and the handoff skill (`/workspace/skills/handoff/SKILL.md`) translates them to `upskill --branch <b> --path <p> <url>` flags on the install command.

## Standard rel set emitted by SLICC

Every cloudflare-worker response carries:

```http
Link: </.well-known/api-catalog>; rel="api-catalog",
      </.well-known/api-catalog>; rel="service-desc"; type="application/linkset+json",
      <https://github.com/ai-ecoverse/slicc>; rel="service-doc",
      </status>; rel="status"; type="application/json",
      </llms.txt>; rel="https://llmstxt.org/rel/llms-txt"; type="text/markdown",
      <https://github.com/ai-ecoverse/slicc/blob/main/LICENSE>; rel="license",
      <https://github.com/ai-ecoverse/slicc#readme>; rel="terms-of-service"
```

Every node-server `/api/*` response carries the same `service-desc`, `service-doc`, `status`, and `terms-of-service` set, with `service-desc` pointing at the localhost `GET /api` JSON catalog and `status` pointing at `GET /api/status`.

## `discover` shell command

`packages/webapp/src/shell/supplemental-commands/discover-command.ts` wraps the proxied fetch + the parser + (optionally) `discoverLinks`:

```bash
discover https://www.sliccy.ai/handoff?handoff=demo
discover --follow https://www.sliccy.ai/llms.txt
```

Output is JSON and includes the parsed link set, any SLICC handoff verb match, and (with `--follow`) the resolved P0 capability documents.

## `playwright-cli` integration

`packages/webapp/src/shell/supplemental-commands/playwright-command.ts` reuses the same parser + discoverer for the subcommands that surface a response to the scoop:

| Subcommand                             | Default                                         | With `--discover`                                                                        |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `playwright-cli fetch <url>`           | JSON with `url`, `status`, `links[]`, `handoff` | Adds `discovery.{catalog,serviceDesc,serviceMeta,status,llmsTxt,failures}`               |
| `playwright-cli goto <url> --tab=<id>` | Plain-text `Navigated to <url>`                 | JSON with `action: "navigate"`, `targetId`, plus the `fetch` payload above (extra fetch) |
| `playwright-cli open [url]`            | Plain-text `Opened <url> in new tab [...]`      | JSON with `action: "open"`, `targetId`, plus the `fetch` payload above (extra fetch)     |

The `--discover` flag is opt-in for the navigation verbs because attaching headers there requires an auxiliary proxied fetch on top of the CDP-driven navigation; the parsed `links[]` are included unconditionally for `fetch` because that subcommand already issues exactly one request. All discovery follow-ups (`api-catalog`, `service-desc`, `service-meta`, `status`, `llms.txt`) route through the same `createProxiedFetch()` adapter the rest of the shell uses, so they inherit CORS bypass, forbidden-header bridging, and the per-link timeout + failure-collection contract of `discoverLinks`.

> **⚠ Headers come from an auxiliary fetch, not the CDP navigation.** For `goto` and `open --discover`, the `links[]`, `handoff`, and `discovery.*` fields are derived from a **separate** proxied `fetch()` issued alongside the CDP-driven navigation, not from the navigation response itself. The auxiliary request may differ from what Chrome actually loaded — different auth state (no SameSite cookies bound to the user's tab session), different redirect chain, and different `Link` headers if the origin varies its response by `User-Agent`, cookies, or `Sec-Fetch-*` hints. The payload carries `source: "auxiliary-fetch"` so scoops can distinguish "headers from the actual navigation" (not currently exposed) from "headers from an auxiliary fetch" (these). When `fetch` alone is sufficient, prefer it: `playwright-cli fetch <url> --discover` issues exactly one request and the headers match what the scoop observed.

```bash
playwright-cli fetch https://www.sliccy.ai/handoff?handoff=demo --discover
playwright-cli goto https://www.sliccy.ai/handoff?handoff=demo --tab=tab-1 --discover
```

## Discovery lick (`ai-catalog.json` + `llms.txt`)

When the user browses to a site that advertises agentic resources, SLICC emits an **informational `discovery` lick** telling the cone the origin is agent-discoverable. The cone **MAY** (never must) fetch the manifest and act — e.g. `mcp add` a listed server or read `llms.txt`. There is no approval card at discovery time; any consequential follow-up is a separate, already-gated cone action.

Two vectors run on every top-level document navigation (never subresources):

- **Header** — a `Link: …; rel="ai-catalog"` (ARD / Agentic Resource Discovery) response header. Reuses the same parser/observer plumbing as `handoff`/`upskill`.
- **Well-known probe** — a background `GET` of `/.well-known/ai-catalog.json` and `/llms.txt`, at most once per origin per session (deduped + timed out + `.catch`ed). Routed through `createProxiedFetch()` (CLI) / the SW's `host_permissions` fetch (extension) so it inherits CORS bypass.

Wiring: CLI/Electron/hosted-leader via `NavigationWatcher` (`packages/webapp/src/cdp/navigation-watcher.ts`); the extension via `createDiscoveryObserver` in `service-worker.ts`; followers forward `discovery` licks to the leader. The lick renders to the cone as `[Discovery Event: <url>]`.

### Setting: "Autodiscover agentic resources" (default ON)

Discovery is **opt-out**. A boolean setting gates **both** vectors in **both** floats — when disabled, neither the header extractor nor the well-known probe run.

- Key: `slicc_discovery_enabled` (anything other than the string `"false"` = enabled).
- UI: Theme/preferences dialog → **Browsing → Autodiscover agentic resources** (`wc-settings.ts`).
- CLI / standalone / hosted-leader: read from `localStorage` in the kernel worker (`discovery-preference.ts` → `host.ts` `isDiscoveryEnabled()`).
- Extension: the SW keeps its own copy in `chrome.storage.local` (read live via `storage.onChanged`); the leader tab mirrors the toggle to the SW over `chrome.runtime.onMessageExternal` (`discovery.set-enabled`, gated to the leader-origin allowlist).

## Wiring history

This pipeline replaces the pre-2.x `x-slicc` proprietary header. The clean break landed in [issue #476](https://github.com/ai-ecoverse/slicc/issues/476). Every consumer (CDP `NavigationWatcher`, `chrome.webRequest` observer, `POST /api/handoff` handler) reads only `Link`; `x-slicc` is no longer parsed anywhere.
