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
They are opt-in, like the `iframe integration` suite — a fan-out run needs 17
live tabs and a compositor that can actually produce frames, so run them
locally when touching `cdp/`:

```bash
SLICC_TEST_CDP_STRESS=1 npx vitest run packages/webapp/tests/cdp/cdp-stress.gate.test.ts
```

Without `SLICC_TEST_CDP_STRESS=1` (or on a machine with no Chrome) the whole
suite skips, so `npm run test` is unaffected.

They launch real Chromes and are sensitive to what else is on the machine: a
`Chrome exited ... before reporting CDP port` failure, or a `CDP WebSocket
connection failed` storm in `fanout`, is load, not a regression. Check for
other Chromes (`pgrep -f 'Google Chrome for Testing'`) and re-run the affected
gate alone (`-t abandoned`) before believing it.

## Exploration

Every scenario is also runnable standalone and prints JSON:

```bash
npx tsx packages/dev-tools/cdp-stress/run-all.ts [--quick]
npx tsx packages/dev-tools/cdp-stress/scenarios/fanout.ts 8 [--poison]
npx tsx packages/dev-tools/cdp-stress/scenarios/session-leak.ts [--watcher] [--leader-tab] [--skip-own-tab]
npx tsx packages/dev-tools/cdp-stress/scenarios/own-tab.ts
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
  `/reloader?every=`, `/hang`, `/console?n=`, `/leader?every=&burst=&goto=&after=`
  (+ a `/ws` echo endpoint); any route takes `?link=` to echo a raw `Link` header.
- `proxy.ts` — single-client `/cdp` relay; `policy: 'node' | 'swift'` model the shipped
  proxies, which now share ONE policy: reconnect the Chrome leg every 1 s indefinitely,
  DISCARD frames buffered under a Chrome/client generation that no longer matches, close
  the client with 4002 `upstream-reset` once the leg is back and after the 3rd consecutive
  failed attempt, and never leave a clientless buffer around (frames buffered before Chrome
  was ever up still flush). `'legacy-swift'` reconnects silently, `'legacy-node'` never
  reconnects; `dropChromeLeg()`, `killClient()`, `evictClient()`.
- `stack.ts` — builds the real client stack from `packages/webapp/src`, wraps
  the transport with counters (sends by method, inbound events by method, burst
  window), optional `NavigationWatcher`.
- `scenarios/` — one file per failure mode, each exporting `run()`:

  | scenario           | failure mode                                                      |
  | ------------------ | ----------------------------------------------------------------- |
  | `session-leak`     | every tab switch mints a session that is never detached           |
  | `load-bleed`       | `goto` resolves on a sibling tab's `Page.loadEventFired`          |
  | `stale-proxy`      | a Chrome-leg drop wipes sessions with no client-side signal       |
  | `stale-worker-hop` | client-leg drop across the `WorkerCdpProxy` hop                   |
  | `fanout`           | cross-tab throughput + lock waits (`--poison` adds a hung `goto`) |
  | `abandoned`        | a caller that gives up still holds the lock                       |
  | `own-tab`          | SLICC's own tab's `/cdp` socket is reported back to it            |

  `abandoned` runs three ways, so the two ways a caller can give up are
  measured side by side: `orphaned` (the caller just stops awaiting — all
  `background_after` could do before cooperative cancellation), `signal` (the
  caller aborts the `AbortSignal` it passed to `withTab`, which is what
  `playwright-cli` now threads the bash tool's abort into), and
  `signal-unresponsive`, which pins the documented limit — against a URL that
  never answers, the command is parked inside the `Page.navigate` round trip,
  and CDP has no cancel verb, so the abort stops the next step but not that
  one.

- `run-all.ts` — runs everything and writes `<out>/<timestamp>.json` +
  `<out>/latest.json`.

## SLICC's own leader tab

`session-leak --leader-tab` opens `/leader` — a page that holds a busy WebSocket
to the site — with `Target.createTarget`, so `BrowserAPI` never attaches and the
`NavigationWatcher` is the only thing that can. `--skip-own-tab` then hands the
watcher an `isOwnTab` predicate matching that URL. Measured here (12 rounds,
4 tabs, macOS):

| run                                     | events per navigation | `Network.webSocketFrame*` |
| --------------------------------------- | --------------------- | ------------------------- |
| `--watcher`                             | 23                    | 0                         |
| `--watcher --leader-tab`                | 35 (33-39)            | 276                       |
| `--watcher --leader-tab --skip-own-tab` | 23                    | 0                         |

So a `Network`-enabled leader tab costs ~12 extra inbound events per navigation,
all of them frames of SLICC's own `/cdp` socket coming straight back at it.

The `own-tab` scenario is the focused version of the same thing, and is the one
the gate asserts. It runs two arms, each with a `/leader` tab that navigates
ITSELF to a page serving a handoff `Link` header:

| arm                       | `Network.webSocketFrame*` while it dwells | handoff lick on the way out |
| ------------------------- | ----------------------------------------- | --------------------------- |
| `isOwnTab` wired          | 0                                         | seen                        |
| unguarded (old behaviour) | 76                                        | seen                        |

The second column is why the app tab keeps `Page` and only loses `Network`: a
watcher that detached from it could not re-attach before the navigation
committed, and the document response carrying the header would be gone.
