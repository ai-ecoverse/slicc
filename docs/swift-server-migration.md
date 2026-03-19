## Swift server migration scaffold

This wave does **not** port the server to Swift. It establishes the boundary that lets a future native macOS app prefer a Swift runtime while preserving the current Node runner as the default and fallback.

### Current TypeScript runtime responsibilities

- `src/cli/index.ts` owns process startup, port allocation, Chrome/Electron launch coordination, and graceful shutdown.
- The same entrypoint hosts the local HTTP server, Vite/static asset serving, OAuth callback relay, tray/webhook/crontask HTTP APIs, and the localhost fetch proxy.
- It also owns the WebSocket bridges for CDP proxying and lick/browser event relays.
- Electron-specific overlay injection remains in `src/cli/electron-controller.ts` and `src/cli/electron-runtime.ts`.

### Migration boundary

The first stable boundary is **runtime selection + spawn contract**, not feature parity.

- Selector module: `src/cli/server-runtime.ts`
- Current contract for both runtimes:
  - process receives `PORT` from the parent launcher
  - process accepts `--serve-only`
  - process accepts `--cdp-port=<port>`
- Runtime preference comes from `SLICC_SERVER_RUNTIME=node|swift`
- Swift binary location comes from `SLICC_SWIFT_SERVER_PATH`
- If Swift is requested but unavailable, SLICC falls back to Node and logs the reason

### Phased migration plan

1. **Wave 1 — boundary + fallback**
   - Keep `src/cli/index.ts` as the live implementation.
   - Add runtime selection and a placeholder Swift spawn contract.
   - Document the responsibilities that must move later.
2. **Wave 2 — launcher/supervisor parity**
   - Introduce a Swift server binary that can boot on the same `PORT` + flag contract.
   - Keep Node as fallback for missing features and dev mode.
3. **Wave 3 — stateless HTTP endpoints**
   - Port runtime-config, OAuth relay, tray status, webhook/crontask management, and fetch-proxy endpoints.
4. **Wave 4 — WebSocket/runtime plumbing**
   - Port CDP proxying, lick WebSocket relay, and shutdown supervision.
5. **Wave 5 — default flip**
   - Promote Swift to the default only after parity verification; retain Node behind an explicit override until confidence is high.

### Initial scaffold implemented now

- `src/cli/server-runtime.ts` centralizes runtime preference parsing, Swift binary resolution, selection/fallback logic, and spawn config construction.
- `src/cli/electron-runtime.ts` now uses that abstraction instead of hard-coding Node spawn decisions.
- `src/cli/electron-main.ts` logs whether it started Node directly or fell back from a requested Swift runtime.

### What stays out of scope in this wave

- No Swift HTTP server implementation yet
- No Swift CDP proxy yet
- No dev-mode Swift runtime path yet
- No removal of the Node CLI server