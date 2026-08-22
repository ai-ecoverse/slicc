# Tier 3 — leader + follower (tray features)

Anything that crosses the tray — teleport, delegated OAuth, federated CDP,
follower rails — needs **two SLICC runtimes**, not two browser windows. A tab
pointed at a join URL is a follower, but a _capability-less_ one: it has no
local CDP surface, so it never advertises targets and can never host a
teleported tab. Most wasted time in multi-harness testing comes from testing
against a follower that cannot do the thing under test, or against a build
that does not contain the change.

## There is an automated leg — check it before hand-driving

`packages/webapp/tests/e2e/multiple-cones-follower.test.ts` (#2313) already runs
a leader + follower pair headlessly on every webapp PR: the leader boots against
the fake LLM, mints a tray on the harness's own `wrangler dev` (a REAL tray hub,
Durable Objects and all), and a second browser context joins at `/join/<token>`.
It covers cone-strip mirroring, a follower changing one cone's model, and
read-only scoop views. Topology helpers: `tests/e2e/two-instance-helpers.ts`;
how to write one: `.agents/skills/writing-slicc-tests/SKILL.md`.

Reach for the manual harness below when the feature needs something that leg
cannot give you — a follower with a local CDP surface (teleport, federated CDP),
a real OAuth popup, or an iOS runtime. The automated follower is UI-only and
will never be teleport-eligible.

## Pick the follower by what the feature needs

| Feature under test                                     | Follower must have                                           | Use                               |
| ------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------- |
| Delegated OAuth popup                                  | a window + permissions surface, **same origin as the relay** | browser tab at the join URL       |
| Teleport pull / push, federated CDP                    | a local CDP surface (advertises targets)                     | second harness, or `slicc-server` |
| iOS-specific paths (cookie teleport, tab presentation) | WKWebView CDP bridge                                         | iOS simulator                     |

Confirm the follower is actually capable before testing — do not infer it from
"it connected". On the leader:

```bash
.agents/skills/cdp-smoke-test/scripts/slicc-cdp eval \
  'localStorage.getItem("slicc.leaderTrayFollowers")'
```

`cdp: true` means it advertised targets; `teleportEligible: true` means the
leader will select it for a teleport. A follower showing `cdp: false` cannot
serve any federated-CDP feature — fix that before interpreting a failure as a
product bug.

## The origin rule (the expensive one)

**A follower runs whatever build its UI origin serves, which is usually NOT
your branch.** `slicc-server` and Sliccstart point Chrome at the production
hosted origin. A follower loaded from `www.sliccy.ai` is running _released_
code; your branch is not in it, and every observation is meaningless.

Your branch reaches an origin two ways: the local wrangler the harness runs
(`http://localhost:8787`), or the staging worker once CI's
`worker-staging.yml` deploys the PR (it triggers on `packages/cloudflare-worker/**`,
`packages/cloud-core/**`, `packages/webapp/{src/,}providers/**`).

Verify at runtime, never by scanning bundles — Vite's dynamic chunks defeat a
naive asset crawl and will tell you code is absent when it is present. Assert
on something only your change renders:

```bash
# e.g. a heading, attribute, or element your branch introduces
slicc-cdp eval 'document.querySelector("slicc-tab-overlay")?.getAttribute("heading")'
```

**Do not fix a wrong origin by navigating the tab cross-origin.** `localStorage`
is origin-scoped, so the stored join URL is orphaned and the float silently
falls back to leader role; the bridge token is origin-bound too, so its CDP
connection starts failing (`[cdp] Connection failed` on repeat, plus
`[page-leader-tray]` log lines from a float you believed was a follower).
Relaunch the follower against the right origin instead.

## Second runtime: `slicc-server` (Swift), not a second Sliccstart

Sliccstart hardcodes bridge `5710` / CDP `9222` and refuses to start when they
are taken (`LaunchError.portInUse`), so a second instance cannot run beside a
developer's live one. Run the Swift server directly:

```bash
PORT=5716 ./packages/swift-server/.build/release/slicc-server \
  --cdp-port 9223 --profile slicc-follower-swift --log-level info
```

`--join-url <url>` joins a tray, but that mode launches Chrome **without** a
`?bridge=` param — no local CDP surface, so it will never be teleport-eligible.
For federated-CDP tests start it plain (it gets a bridge) and join from its own
UI, then confirm with the roster check above.

A plain `--user-data-dir` Chrome at a join URL is fine for origin-sensitive
tests (delegated OAuth) and nothing else; it is not harness-controlled.

## Port map

Production is `:5710` / `:9222` and is off-limits (see the main SKILL). Keep a
stable lane so runs are reproducible:

| Role                         | Bridge | Chrome CDP                       |
| ---------------------------- | ------ | -------------------------------- |
| Leader (SLICC-Node harness)  | `5715` | auto (read from the harness log) |
| Follower (SLICC-Swift)       | `5716` | `9223`                           |
| Origin-only browser follower | —      | `9333`                           |

Re-verify production PIDs are unchanged after every launch, not just the first.

## Driving the terminal

`slicc-cdp term` sends Ctrl+U then types then presses Enter. Sending commands
back-to-back interleaves with readline and wedges the session
(`terminal prompt never appeared — kernel session not ready`, and residue like
`hosto` / `ut` in the buffer). Wait for `term-text` to show the previous
command's output before sending the next, and treat a `send failed` as
_unknown_, not failed — the command may well have run. Confirm through the UI
or a page eval before concluding anything. A leader-page reload restores a
wedged kernel session.

## Read the UI through shadow roots, never `body.innerText`

SLICC's UI is web components, so `document.body.innerText` sees almost none of
it. Checking `innerText.includes(...)` to answer "did the message arrive?" or
"did the command run?" returns **false for things that are plainly on screen** —
a false negative that reads exactly like a broken feature. Walk the tree
instead, recursing into every `shadowRoot`, and read the terminal from the
`xterm-screen` element's rows:

```js
const walk = (root, hit) => {
  for (const el of root.querySelectorAll('*')) {
    if (hit(el)) return el;
    if (el.shadowRoot) {
      const f = walk(el.shadowRoot, hit);
      if (f) return f;
    }
  }
  return null;
};
```

Redact before printing: `oauth-token` and friends emit live credentials, and a
terminal dump lands verbatim in the transcript
(`.replace(/gh[oprsu]_[A-Za-z0-9]+/g, '<REDACTED>')`).

## Where a float's logs actually are

`slicc-cdp watch` attaches to page targets. Provider and shell-command logging
runs in the **kernel worker**, so an empty console log is not evidence the code
did not run. The harness log (`SLICC_HARNESS_LOG`) is wrangler HTTP traffic
only — also not app logs. On attach the watcher replays buffered console
history stamped with the attach time, so entries printed _above_
`=== watcher attached ===` are from earlier runs; only lines below it belong to
the run you just triggered.

## Capabilities that need a real gesture

`window.open` from `Runtime.evaluate` has no user activation and is blocked, so
a popup-based flow cannot be triggered by eval. Either drive the real click
(`slicc-cdp click`) or test the mechanism below the popup — e.g. open the
callback URL as its own CDP target and assert on the delivery channel.

## Reporting rule

State which build each runtime was running and which capabilities each
follower advertised. A pass against a production-code follower, or a fail
against a `cdp: false` follower, is not evidence either way — say so rather
than reporting it as a result.
