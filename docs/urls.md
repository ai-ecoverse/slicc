## URL scheme

SLICC serves a small set of stable routes from its local origin (`http://localhost:3000` by default).

| URL | Purpose |
| --- | --- |
| `/` | Main browser app in standalone CLI mode |
| `/electron` | Electron overlay app shell |
| `/electron-overlay-entry.js` | Injected Electron overlay entry bundle |
| `/auth/callback` | OAuth redirect target — reads query params + URL fragment, postMessages back to opener popup |
| `/licks-ws` | WebSocket endpoint for lick events |
| `/webhooks/:id` | Incoming webhook endpoint |

## Electron overlay URL

- Use `http://localhost:3000/electron` for the default Electron overlay tab (`chat`).
- Use `http://localhost:3000/electron?tab=memory` to open a specific initial tab.
- Supported tabs are the standard tabbed UI ids (`chat`, `terminal`, `files`, `memory`).

## Backward compatibility

The UI still recognizes the older query-based Electron overlay URL (`/?runtime=electron-overlay&tab=...`), but new Electron links should use the cleaner path-based `/electron` form.