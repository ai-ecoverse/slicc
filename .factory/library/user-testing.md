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

1. Start the `dev` service defined in `.factory/services.yaml` (binds UI to `http://localhost:5710` and Chrome CDP to `http://localhost:9222`)
2. Use the `agent-browser` skill to connect via CDP to the running Chrome instance
3. Navigate to `http://localhost:5710`
4. Interact with the SLICC UI — open the terminal panel, type `agent ...` commands, observe output in the terminal panel
5. Capture screenshots/logs as evidence

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

## Known Constraints

- Extension build produces a Chrome extension bundle — not tested in dev mode; validated via `npm run build -w @slicc/chrome-extension` gate.
- Manual agent invocation requires a user-configured LLM provider (stored in browser IndexedDB). Validators cannot populate this from outside the browser; they must drive the UI to configure it, OR document that the smoke test is provider-gated.

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
