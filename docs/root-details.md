# Root CLAUDE.md — Detail Overflow

Descriptions for items summarized in the root [`CLAUDE.md`](../CLAUDE.md). Update
this file when a category grows; keep the root file to bare titles.

## Module Map — Package Purposes

| Path                           | Purpose                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `packages/webapp/`             | Browser app core (UI, VFS, shell, CDP, tools, providers, skills, scoops)                 |
| `packages/cherry/`             | Host-side embed SDK (`mountSlicc`) lending a third-party page to a leader                |
| `packages/chrome-extension/`   | Manifest V3 extension entry points, HTML shells, message bridges                         |
| `packages/cloudflare-worker/`  | Tray hub worker: sessions, signaling, TURN, `sliccy.ai/cloud` dashboard                  |
| `packages/node-server/`        | Node CLI/Electron server: Chrome launch, CDP proxy, dev serve, hosted-leader             |
| `packages/cloud-core/`         | `@slicc/cloud-core` — sandbox-lifecycle lib (worker + `node-server --cloud`)             |
| `packages/shared-ts/`          | `@slicc/shared-ts` — platform-agnostic primitives (secret masking pipeline)              |
| `packages/webcomponents/`      | `@slicc/webcomponents` — webapp UI shell (Storybook + `@vitest/browser`)                 |
| `packages/spoon/`              | `@ai-ecoverse/spoon` — injection overlay + IIFE bootstrap; used in all floats            |
| `packages/vfs-root/`           | Default VFS content copied into the app on init/reset                                    |
| `packages/go-optel/`           | Dependency-free Go RUM client used by `slicc-cli`                                        |
| `packages/swift-launcher/`     | macOS SwiftUI launcher app (`Sliccstart`)                                                |
| `packages/swift-optel/`        | Pure-Swift RUM library shared by iOS + macOS apps                                        |
| `packages/swift-server/`       | macOS Hummingbird server (`slicc-server`)                                                |
| `packages/swift-traysession/`  | Foundation-only iCloud tray-session sync (launcher + iOS)                                |
| `packages/swift-trayfollower/` | `SliccTrayFollower` — shared tray-follower transport (WebRTC + tray-sync)                |
| `packages/ios-app/`            | iOS SwiftUI follower (`SliccFollower`) — WebRTC join (SPM, not npm)                      |
| `packages/slicc-cli/`          | `slicc` — headless Go (pion) follower CLI (`prompt`/`exec`/`follow`; Go module, not npm) |
| `packages/dev-tools/`          | Repo tooling: build helpers, QA, providers filter, e2b template                          |
| `packages/assets/`             | Shared static files (logos, fonts, favicon); folder, not an npm workspace                |

## Automated PR Review Checklist — Descriptions

Numbering matches the root checklist. Full catalog:
[`review-patterns.md`](review-patterns.md).

1. **Error-path coverage** — timeouts/retries/`.catch` on external calls.
2. **UI state preservation** — capture+restore UI state around DOM rebuilds.
3. **Cross-runtime parity** — peer runtimes updated or explicitly excluded.
4. **CDP edge cases** — foreground before screenshots; validate target/port.
5. **Native/macOS permissions** — entitlements + TCC check + graceful denial.
6. **Model metadata / provider pipeline** — metadata forwarding, version
   predicates, thinking levels, costs; see [`pitfalls.md`](pitfalls.md).
7. **Test coverage** — mirrored `tests/`; bug fixes ship regression tests.
8. **Follower wiring parity** — leader broadcasts need matching follower
   handler + UI action; check all boot paths.
9. **Origin/bridge routing** — `fetch('/api/...')` must work in thin-bridge
   mode; normalize trailing slashes.
10. **Agent skill freshness** — shell command changes → update matching
    `vfs-root/workspace/skills/*/SKILL.md`.
11. **Transcript export** — fail-closed redaction; approval gate; unknown
    errors → `transfer-corrupt`; SHA-256.
12. **Layer import direction** — no new `ui/` imports below ui; move helpers
    down.
13. **Untyped string-keyed bags** — no new `Record<string, unknown>` in source;
    name the shape, or `// biome-ignore lint/plugin:` with a reason.
