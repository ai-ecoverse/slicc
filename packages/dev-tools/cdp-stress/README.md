# CDP bridge stress harness

Drives the unmodified SLICC client stack (`BrowserAPI` → `WorkerCdpProxy` →
page `CDPClient` → `/cdp`) from Node against a real headless Chrome, with a
local test site and a stand-in `/cdp` proxy that reproduces node-server and
swift-server behaviour. Findings and fix plan: [ai-ecoverse/slicc#2417](https://github.com/ai-ecoverse/slicc/issues/2417#issuecomment-5567295502).

Requires Chrome on this machine (`findChromeExecutable()` from the node-server
launcher, override with `CHROME_BIN`) and `npm install` in the repo.

## Gates

The pass criteria live in
[`packages/webapp/tests/cdp/cdp-stress.gate.test.ts`](../../webapp/tests/cdp/cdp-stress.gate.test.ts).
They are opt-in, like the `iframe integration` suite, and are **expected to fail
until the per-tab session registry and per-tab locking land**:

```bash
SLICC_TEST_CDP_STRESS=1 npx vitest run packages/webapp/tests/cdp/cdp-stress.gate.test.ts
```

Without `SLICC_TEST_CDP_STRESS=1` (or on a machine with no Chrome) the whole
suite skips, so `npm run test` is unaffected.

## Exploration

Every scenario is also runnable standalone and prints JSON:

```bash
npx tsx packages/dev-tools/cdp-stress/run-all.ts [--quick]
npx tsx packages/dev-tools/cdp-stress/scenarios/fanout.ts 8 [--poison]
npx tsx packages/dev-tools/cdp-stress/scenarios/session-leak.ts [--watcher]
npx tsx packages/dev-tools/cdp-stress/scenarios/stale-proxy.ts
npx tsx packages/dev-tools/cdp-stress/scenarios/load-bleed.ts
npx tsx packages/dev-tools/cdp-stress/scenarios/abandoned.ts
npx tsx packages/dev-tools/cdp-stress/scenarios/stale-worker-hop.ts
```

Environment knobs:

- `CHROME_BIN` — Chrome executable override.
- `HARNESS_CDP_TIMEOUT_MS` — per-command CDP timeout (production default 30000;
  `run-all` uses 8000 so the node-policy stale run finishes quickly).
- `HARNESS_ITER` — fan-out iterations per driver.
- `HARNESS_ROUNDS` — session-leak rounds.
- `HARNESS_OUT` — `run-all` output directory (default `dist/cdp-stress/`).

## Layout

- `chrome.ts` — launches headless Chrome with a throwaway profile.
- `site.ts` — local HTTP site: `/page/<name>?delay=&subdelay=&items=`,
  `/reloader?every=`, `/hang`, `/console?n=`.
- `proxy.ts` — single-client `/cdp` relay; `policy: 'node'` drops frames after a
  Chrome-leg close, `policy: 'swift'` silently reconnects; `dropChromeLeg()`,
  `killClient()`, `evictClient()`.
- `stack.ts` — builds the real client stack from `packages/webapp/src`, wraps
  the transport with counters (sends by method, inbound events by method, burst
  window), optional `NavigationWatcher`.
- `scenarios/` — one file per failure mode, each exporting `run()`:
  | scenario           | failure mode                                                                |
  | ------------------ | --------------------------------------------------------------------------- |
  | `session-leak`     | every tab switch mints a session that is never detached                     |
  | `load-bleed`       | `goto` resolves on a sibling tab's `Page.loadEventFired`                    |
  | `stale-proxy`      | a Chrome-leg drop wipes sessions with no client-side signal                 |
  | `stale-worker-hop` | client-leg drop across the `WorkerCdpProxy` hop                             |
  | `fanout`           | one global tab lock serializes every driver (`--poison` adds a hung `goto`) |
  | `abandoned`        | a caller that gives up still holds the lock                                 |
- `run-all.ts` — runs everything and writes `<out>/<timestamp>.json` +
  `<out>/latest.json`.
