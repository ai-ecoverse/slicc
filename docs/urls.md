## URL scheme

SLICC serves a small set of stable routes from its local origin (`http://localhost:3000` by default).

| URL | Purpose |
| --- | --- |
| `/` | Main browser app in standalone CLI mode |
| `/electron` | Electron overlay app shell |
| `/electron-overlay-entry.js` | Injected Electron overlay entry bundle |
| `/licks-ws` | WebSocket endpoint for lick events |
| `/webhooks/:id` | Incoming webhook endpoint |

## Electron overlay URL

- Use `http://localhost:3000/electron` for the default Electron overlay tab (`chat`).
- Use `http://localhost:3000/electron?tab=memory` to open a specific initial tab.
- Supported tabs are the standard tabbed UI ids (`chat`, `terminal`, `files`, `memory`).

## Tray launch URLs

- Standalone tray launches use the canonical `tray` query parameter instead of the older `lead` / `trayWorkerUrl` forms.
- Leader launches can start with just the worker base URL:
  - `http://localhost:3000/?tray=https://tray.example.com/base`
- After the leader connects, the URL is canonicalized so the active tray/session id is visible:
  - `http://localhost:3000/?tray=https://tray.example.com/base/tray/tray-123`
- Follower launches carry the capability attach path through the same `tray` parameter:
  - `http://localhost:3000/?tray=https://tray.example.com/base/join/tray-123.capability-token`
- Runtime resolution preserves the follower `join` URL for attach/signaling, while still recovering the worker base URL from the same value.
- Runtime resolution still accepts the legacy `lead` and `trayWorkerUrl` parameters for backward compatibility, but new launch flows should emit `tray`.

## Backward compatibility

The UI still recognizes the older query-based Electron overlay URL (`/?runtime=electron-overlay&tab=...`), but new Electron links should use the cleaner path-based `/electron` form.