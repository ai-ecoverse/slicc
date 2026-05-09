# Link header discovery (RFC 8288 / RFC 9727)

SLICC parses `Link` (RFC 8288) headers on every response a scoop fetches, and emits `Link` headers on every response it serves. The parser, discoverer, and emitters are reusable across the worker, the node-server, the webapp, and the chrome extension.

## Modules

| Path                                            | Purpose                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/src/net/link-header.ts`        | Pure RFC 8288 parser + builder. Handles comma-split inside quoted strings, multi-instance merge, RFC 8187 `param*=UTF-8''…` ext-values, and anchor/href URI resolution. |
| `packages/webapp/src/net/discover-links.ts`     | Async P0 discovery: fetches `api-catalog`, `service-desc`, `service-meta`, `status`, `llms-txt`. Per-link timeout + `failures[]` collector.                             |
| `packages/webapp/src/net/handoff-link.ts`       | SLICC verb-dispatch wrapper around the parser. Returns `{ verb, target, instruction? } \| null`.                                                                        |
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

## Standard rel set emitted by SLICC

Every cloudflare-worker response carries:

```http
Link: </.well-known/api-catalog>; rel="api-catalog",
      </.well-known/api-catalog>; rel="service-desc"; type="application/linkset+json",
      <https://github.com/ai-ecoverse/slicc>; rel="service-doc",
      </llms.txt>; rel="https://llmstxt.org/rel/llms-txt"; type="text/markdown",
      <https://github.com/ai-ecoverse/slicc/blob/main/LICENSE>; rel="license",
      <https://github.com/ai-ecoverse/slicc#readme>; rel="terms-of-service"
```

Every node-server `/api/*` response carries the same `service-desc`, `service-doc`, and `terms-of-service` set, with `service-desc` pointing at the localhost `GET /api` JSON catalog.

## `discover` shell command

`packages/webapp/src/shell/supplemental-commands/discover-command.ts` wraps the proxied fetch + the parser + (optionally) `discoverLinks`:

```bash
discover https://www.sliccy.ai/handoff?handoff=demo
discover --follow https://www.sliccy.ai/llms.txt
```

Output is JSON and includes the parsed link set, any SLICC handoff verb match, and (with `--follow`) the resolved P0 capability documents.

## Wiring history

This pipeline replaces the pre-2.x `x-slicc` proprietary header. The clean break landed in [issue #476](https://github.com/ai-ecoverse/slicc/issues/476). Every consumer (CDP `NavigationWatcher`, `chrome.webRequest` observer, `POST /api/handoff` handler) reads only `Link`; `x-slicc` is no longer parsed anywhere.
