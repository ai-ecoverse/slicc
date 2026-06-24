## URL scheme

SLICC serves a small set of stable routes from its local origin (`http://localhost:5710` by default).

| URL                          | Purpose                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                          | Main browser app in standalone CLI mode                                                                                                                                                       |
| `/electron`                  | Electron page entry against the hosted webapp (gated by `?bridge=…&bridgeToken=…&role=leader\|follower`)                                                                                      |
| `/electron-overlay-entry.js` | Legacy injected Electron overlay entry bundle (retained for any external reinjection callers; no longer injected by the thin-bridge release — Electron pages load the hosted webapp directly) |
| `/auth/callback`             | OAuth redirect target — reads query params + URL fragment, postMessages back to opener popup                                                                                                  |
| `/licks-ws`                  | WebSocket endpoint for lick events                                                                                                                                                            |
| `/webhooks/:id`              | Incoming webhook endpoint                                                                                                                                                                     |

## Electron entry URL

- The overlay always loads from the **hosted-leader origin** (`https://www.sliccy.ai` in production, `http://localhost:8787` for the wrangler dev harness) — never the local serve port. The legacy bundled-UI overlay served from `http://localhost:<servePort>/electron` was retired; the local serve port now hosts only the `/cdp` bridge.
- Use `https://www.sliccy.ai/electron?bridge=ws://localhost:9223/cdp&bridgeToken=<token>&role=leader` to point an Electron page at the hosted webapp as the bridge leader. Followers use `&role=follower`.
- `?tab=<id>` still selects the initial tabbed UI id (`chat`, `terminal`, `files`, `memory`) for compatibility.

## Tray launch URLs

- Standalone tray launches use the canonical `tray` query parameter instead of the older `lead` / `trayWorkerUrl` forms.
- The CLI mirrors that canonical query handling:
  - `--lead <worker-base-url>` -> `?tray=<worker-base-url>`
  - `--join <join-url>` -> `?tray=<join-url>`
- Leader launches can start with just the worker base URL:
  - `http://localhost:3000/?tray=https://tray.example.com/base`
- After the leader connects, the URL is canonicalized so the active tray/session id is visible:
  - `http://localhost:3000/?tray=https://tray.example.com/base/tray/tray-123`
- Follower launches carry the capability attach path through the same `tray` parameter:
  - `http://localhost:3000/?tray=https://tray.example.com/base/join/tray-123.capability-token`
- CLI `--join` launch handling accepts only canonical tray join URLs, preserving the `join` path while removing any hash/query suffixes before writing the `tray` query.
- The no-provider settings dialog uses that same validation rule for its `Join a tray` action and stores the normalized `/join/...` URL for the runtime to consume.
- Runtime resolution preserves the follower `join` URL for attach/signaling, while still recovering the worker base URL from the same value.
- Runtime resolution still accepts the legacy `lead` and `trayWorkerUrl` parameters for backward compatibility, but new launch flows should emit `tray`.

## Backward compatibility

The UI still recognizes the older query-based Electron entry URL (`/?runtime=electron-overlay&tab=...`) and the `electron-overlay` `UiRuntimeMode` value for backward compatibility, but new Electron links should use the path-based `/electron?bridge=…&bridgeToken=…&role=…` form.
