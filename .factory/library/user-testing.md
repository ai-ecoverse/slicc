# User Testing

How to validate the `agent` command through its user-facing surfaces.

## Validation Surface

Two surfaces, both must be green before a milestone is considered complete:

### 1. Vitest (headless, primary)

All behavioral assertions backed by unit/integration tests in `packages/webapp/tests/`. Run via:

```bash
npm run test
```

Unit + integration tests are the primary gate — they cover argument parsing, allow-list enforcement, scoop lifecycle, output capture, filesystem ACL, error paths, and cleanup.

### 2. Live Browser (CDP + agent-browser)

The user explicitly requested: **"launch a dev server, let the user investigate manually; during development keep the dev server open, connect through CDP, and drive the agent within the browser."**

This means workers and validators MUST:

1. Start the `dev` service defined in `.factory/services.yaml` (binds UI to `http://localhost:5710`; Chrome CDP defaults to `:9222`).
2. **Discover the actual CDP port.** If port 9222 is already occupied on the machine, the dev server's chromium-launcher auto-allocates an ephemeral port. Read the dev-server log after startup for lines like `CDP proxy at ws://localhost:5710/cdp` or a `remote-debugging-port=<N>` token. Prefer connecting via `ws://localhost:5710/cdp` because the proxy port is stable regardless of Chrome's actual port.
   - If the proxy handshake intermittently reports `No page found`, fall back to the discovered Chrome CDP port from the dev-server log for that validation run; you are still testing the same shared browser.
3. Use the `agent-browser` skill to connect via CDP (prefer the :5710 proxy endpoint) to the running Chrome instance.
4. Navigate to `http://localhost:5710`.
5. Interact with the SLICC UI — open the terminal panel, type `agent ...` commands, observe output in the terminal panel.
6. Capture screenshots/logs as evidence.

**Discovery helper** (run after `fireAndForget` start):

```bash
# Wait briefly, then grep the dev-server log for the CDP endpoint.
rg -o 'remote-debugging-port=\d+|CDP proxy at ws://localhost:\d+/cdp' <log-file>
```

**Vite transform-cache gotcha** (learned in core-followup-2, fix-agent-bridge-chat-panel-wiring, 2026-04-17): a long-running Vite dev server can serve stale transformed output for source files that were edited AFTER the server started, even through file-save / touch / browser reload / `cache: 'reload'` fetch. Symptom: `curl http://localhost:<PORT>/packages/webapp/src/<file>.ts` returns the OLD transformed code, so the browser's loaded module is stale and manual CDP verification tests pre-fix behavior. Detection: `curl` the file and grep for an identifier you just added; if absent, cache is stale. Only cache-busting query params (`?t=<ts>`) return fresh code on the stale path. **Mitigation:** before manual CDP verification on a dev server that predates your source changes, restart it (`lsof -ti :<PORT> | xargs kill -9` then `PORT=<PORT> npm run dev &`) and re-launch the browser to the fresh port. The orchestrator restarts the dev server between fix-and-verify cycles when UI-visible behavior is the fulfills target.

**Orphan Chrome profile-lock gotcha** (learned in core-followup-2 user-testing, 2026-04-17): if you reclaim port `5710` by killing an existing `slicc-ser` / dev-server process, its Chrome child can survive as an orphan and keep `--user-data-dir=.../browser-coding-agent-chrome` locked. The next `npm run dev` then fails almost immediately with `Chrome exited with code 0 before reporting CDP port`. Detection: `ps -p <chrome-pid> -o pid=,ppid=,command=` shows `PPID 1` plus the `browser-coding-agent-chrome` user-data dir, and `lsof -nP -iTCP:9222 -sTCP:LISTEN` (or the previously assigned CDP port) still points at that orphan. **Mitigation:** kill the orphan Chrome PID, then restart the dev server.

For interactive `agent` validation, the LLM provider must be configured in the running app before exercising the command. If no provider is configured, agent invocation will fail with a provider-missing error — record that as a distinct failure mode rather than treating it as a bug.

**Tool selection:** `agent-browser` is REQUIRED for the live-browser surface (per Factory guidance for web apps).

## Validation Concurrency

**Machine:** 8 CPUs, 24 GB RAM. Baseline load was high during measurement (load avg ~11) — treat concurrency conservatively.

### Vitest surface

- `npm run test` is a single Vitest process. Running it in parallel with itself would collide on `fake-indexeddb` state and the shared dist artifacts.
- **Max concurrent validators: 1**

### Live-browser surface (dev server + agent-browser)

- Each validator needs the dev server running (~400-700 MB RAM including Vite/esbuild + node-server + spawned Chrome). Running two dev servers would require distinct ports (e.g. 5720, 5730), two Chrome profiles, two CDP ports.
- Agent-browser session adds ~300 MB per validator.
- On 24 GB with ~6 GB baseline and load avg ~11, usable headroom ≈ (24 - 6) × 0.7 = **12.6 GB**.
- Per validator cost: ~1 GB (dev server + Chrome + agent-browser).
- Theoretical: ~10 concurrent. Practical cap: **2** concurrent validators — the SLICC app launches a real Chrome instance and CDP routing gets messy with parallel instances; the user's stated workflow is single-user investigation.

### Shell surface

- Read-only shell checks (`rg`, `curl`, `git status`, file listings) are cheap and do not interfere with Vitest or the dev server.
- Because machine load is already elevated, keep shell validators conservative anyway.
- **Max concurrent validators: 2**

## Known Constraints

- Extension build produces a Chrome extension bundle — not tested in dev mode; validated via `npm run build -w @slicc/chrome-extension` gate.
- Manual agent invocation requires a user-configured LLM provider (stored in browser IndexedDB). Validators cannot populate this from outside the browser; they must drive the UI to configure it, OR document that the smoke test is provider-gated.
- A fresh browser session may land on the provider dialog instead of the already-initialized workspace. For provider-free smoke checks against a running dev server, attaching to the shared dev Chrome session is often more reliable than opening a brand-new session.

## Flow Validator Guidance: vitest

- Run from the repo root only.
- Do **not** start or stop services from a Vitest validator; the parent validator manages shared setup.
- Keep Vitest isolated: only one Vitest validator may run at a time.
- Prefer the smallest test selection that fully covers the assigned assertions; if a broader run is needed, record why in the flow report.
- Treat the repo as read-only except for the assigned flow report and evidence files.

## Flow Validator Guidance: shell

- Shell validators are read-only unless the prompt explicitly assigns a report/evidence path.
- Do not modify source files, install dependencies, or stop shared services.
- Use absolute paths in commands and prefer `rg`, `jq`, `git status`, and `curl` over ad hoc shell scripts.
- If a shell check depends on the dev server, use the parent's shared server at `http://localhost:5710`.

## Flow Validator Guidance: agent-browser

- Use the shared dev server at `http://localhost:5710` and prefer the stable CDP proxy at `ws://localhost:5710/cdp`.
- Stay inside the assigned browser surface; do not open unrelated sites or mutate settings outside the assigned scope.
- For the `core` milestone, prefer provider-free terminal checks (`agent --help`, malformed invocation, hook presence) unless the prompt explicitly assigns provider setup.
- Capture screenshots and terminal text for each assigned assertion, and include any console errors in the flow report.
- Leave dev-server lifecycle management to the parent validator; do not kill the shared server.

## Testable Behaviors (high level)

Per the validation contract (`validation-contract.md`), validation covers:

- Command surface: argument parsing, help text, error messages
- Scoop lifecycle: spawn, feed, wait, cleanup
- Output capture: `send_message` path, last-assistant fallback
- Filesystem ACL: R/W on supplied cwd, R/W on /shared/, R/O on /workspace/
- Shell allow-list: allowed commands run, disallowed rejected, `*` bypasses
- Model selection: inherit default, `--model` override
- Nesting: callable from cone and from a scoop
- CI gates: prettier, typecheck, test, builds (webapp + extension)
- Live browser flow: end-to-end user experience in the terminal panel
