# CLAUDE.md

Browser app (`packages/webapp/`). Extension-only behavior:
[`packages/chrome-extension/CLAUDE.md`](../chrome-extension/CLAUDE.md).
Runtime/server: float-specific guides. Overflow:
[`docs/webapp-details.md`](../../docs/webapp-details.md).

## Commands

```bash
npm run build -w @slicc/webapp           # Vite → dist/ui/
npm run test  -w @slicc/webapp           # vitest --project webapp
npm run typecheck                        # repo-wide tsc
npx vitest run packages/webapp/tests/<file>.ts
```

Payload: `npm run size -w @slicc/webapp`. Workflows: `docs/development.md`.

## Architecture

Imports only downward. Consumed by node-server and chrome-extension floats.

```text
Virtual Filesystem (fs/) → RestrictedFS → Shell (shell/) + Git (git/)
  → CDP (cdp/) → Tools (tools/) → Core Agent (core/)
    → Scoops Orchestrator (scoops/) → UI (ui/)
```

```text
User → ChatPanel → Orchestrator → ScoopContext.prompt() → pi-agent-core → LLM API
  → tool calls → RestrictedFS / AlmostBashShell / BrowserAPI
  → results → agent loop → UI updates / scoop routing
```

## Subsystems

Paths under `packages/webapp/src/`. File maps: `docs/webapp-details.md`.

- Kernel host — `kernel/` — `docs/kernel/process-model.md`
- Orchestrator + tray — `scoops/`
- WorkUnit — `work-unit/` — `docs/work-unit.md`
- VirtualFS + mounts — `fs/` — `docs/mounts.md`
- Shell (`.jsh`/`.bsh`, MCP) — `shell/` — `docs/shell-reference.md`
- Speech — `speech/`
- CDP + cherry — `cdp/`
- Tools — `tools/` (browser automation is shell commands, not a tool family)
- Sudo — `sudo/` + `fs/sudo-fs.ts` + `shell/sudo/` — `docs/approvals.md`
- Bash progress — `shell/progress/` — `docs/exploration/bash-progress-overlay.md`
- Core agent — `core/` — pi-agent-core + pi-ai; `tool-adapter.ts`; flags; compaction
- UI + layouts — `ui/`, `ui/wc/` — `docs/layouts.md`
- Skills — `skills/`
- Sprinkles + Dips — `ui/sprinkle-*.ts`, `ui/dip.ts`
- Stale-asset recovery — `ui/boot/setup-preload-error-reload.ts` + `core/stale-asset-channel.ts`

## File mentions + preview

Heuristic and VFS stay split. Confirm, then linkify; never decorate a streaming
bubble. `getMimeType()` (`core/mime-types.ts`) is for **serving**;
`sniffFileType()` (`core/file-type.ts`) is for **reading** — never swap them.
Raw HTML is never sanitized or mounted inline (Quick Look iframe). Remaining
rules: `docs/webapp-details.md` (File mentions).

## Never-Rules

- **Kernel realms**: `runInRealm()` → per-task `DedicatedWorker`; SIGKILL → 137. Sync fs/exec go through `realm/sync-{xhr,fs-*,exec-*}.ts` +
  `ui/sync-fs-sw-handler.ts` with per-realm tokens; never bypass. Isolated
  leader: `realm/sync-sab-*.ts` (Atomics/SAB) only for `Realm.isolatedThread`
  — the in-process factory must never get a SAB (self-deadlock).
  `docs/kernel/process-model.md`.
- **Cone/scoop are roles over one `WorkUnit`**: `parentJid === null` is the
  root test (`isRootUnit`). No `isCone`/`type` on the record; `isCone` is
  follower-wire only. New `scoops/`/`kernel/` code asks
  `orchestrator.getWorkUnits()` or `policy.*`. Directory layout from
  `workspaceFor` alone — never hardcode `/workspace`. Users never talk to a
  scoop (`isReadOnlyUnit`); human input goes to the owning cone, never
  `defaultRoot()`. Conversation is one append-only canonical record;
  Pi/UI/transcripts are derivations. Never make a canonical read fatal or
  delete a legacy record. `docs/work-unit.md`.
- **Scoop queue**: pure-lick batches defer while `ScoopContext.isBusy`
  without queue/watermark loss; user `web` bypasses (immediate/awaited).
  `transcript-limits.ts` caps **bridge** transcripts at 64 KB — never
  `agent-sessions` history or compaction input.
- **Agent bridge** (`agent-bridge.ts`): writable
  `[cwd, /shared/, <scratch>/, /tmp/]`, visible
  `[...defaultChildVisibleRoots(owning cone), invokingCwd]`; `--read-only`
  replaces them.
- **Mount signing is browser-naive**: CLI → `/api/s3-sign-and-forward`,
  extension → SW. Never sign in the browser. `docs/mounts.md`.
- **Shell/mount cache**: `script-catalog.ts` caches per `$PATH` root set;
  bypass `FsWatcher` cache only for root sets a mount overlaps. `.jsh`
  lookup follows `$PATH` — never a full-VFS scan.
- **`typescript` v7 has no browser/WASM API** — `typescript-js` (v6) for
  browser `tsc`/`test`/`esm-transpile`. `builtin-shadow-map.ts` is
  authoritative for `ipx`/`npx` redirects.
- **`esbuild.initialize` needs `worker: false` + a bounded wait** in every
  browser float. Never cache a load promise that can stay pending.
  `docs/pitfalls.md`.
- **Speech is page-realm only** (mic, AudioContext); kernel worker uses
  `hear-*` panel-RPC. Extension `uiOnly` side panel: skip `ptt` and drop
  "Take a photo". Worker build stubs `speech/speak.ts` + `speech/hear.ts`
  (`stubPageRealmSpeechPlugin`); never import a model-id constant from an
  engine (`speech/model-ids.ts`). Bundle rules: `docs/pitfalls.md`.
- **Sprinkle element bundles ride the app chunk graph.** `<slicc-diff>` /
  `<slicc-editor>` are Rollup entries; `dist/ui/slicc-diff.js` /
  `slicc-editor.js` are stable-name shims. Adopt pre-upgrade properties
  (`ui/upgrade-own-properties.ts`); method APIs await
  `window.__SLICC_SPRINKLE_ASSETS__['slicc-diff.js']`.
- **Cherry origin** (`cherry-host-transport.ts`): `resolveParentOrigin()`
  prefers `location.ancestorOrigins[0]`. Envelope gate
  (`cherry-host-protocol.ts`): origin allowlist + `MessageEvent.source` +
  per-mount `channelId`. Keep `packages/cherry/src/protocol.ts` in sync.
- **Sudo**: writes to `/etc/sudoers` + `/etc/sudoers.d/*` always need
  approval (`matchPath`). Capture natives at module init
  (`sudo/panel-responder.ts`); mount chrome via `ui/wc/trusted-layer.ts`,
  never `document.body`. Panel terminal is **not** gated. Brokers:
  `createSudoBroker` + `withApprovalTimeout` (5 min
  `{ decision: 'deny', reason: 'user-timeout' }`; scoop→cone uses
  `cone-timeout`). `reason` is a field, never a fourth `decision` value.
  `docs/approvals.md`.
- **`/tmp` is granted to every scoop** — `builtinScoopGrants()`
  (`base/sudoers.ts`) + `ALWAYS_WRITABLE_PREFIXES` (`fs/restricted-fs.ts`).
  Change both layers together. Shared: never put a secret there; private
  scratch is `/scoops/<folder>/tmp`.
- **Frozen-session recovery** uses the **bounded** legacy enrichment call —
  never the unbounded curator (`timeoutSeconds` cannot stop it). Save /
  Skip memory / Erase clear the **selected** cone's chat and non-mount
  `/tmp`, not scoops, keyed by `chatSessionIdFor`. Welcome flow is
  primary-cone-only.
- **Layouts**: `panel-layouts` flag. `panelize-shell.ts` re-parents
  `mountWcShell` so `WcShellRefs` stays valid. `setPanelVisible` adds an
  unplaced panel but never duplicates a placed one; `sanitizeLayoutName`
  guards the path. `docs/layouts.md`.
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts`
  removes only `localStorage['slicc_cloud_managed']` providers. `?connect=1`
  is login-only (`ui/connect-surface.ts`), no kernel.
- **Never monkeypatch a method on a get/set-asymmetric Proxy**
  (`MONKEYPATCH_UNSAFE_FS`). Reassigning a gated method OOMs the kernel
  worker.
- **Adobe `X-Session-Id`**: every Adobe-proxy LLM call must attach it.
  `scoop-context.ts` wires agent `streamFn` + compaction; new sites
  (`streamSimple`/`completeSimple`) must attach it. `ensureSessionIdHeader`
  is defense-in-depth, not the fix location.
- **Claude Bedrock shims** (temperature rejected by Opus ≥ 4.7; adaptive
  thinking for Opus/Sonnet ≥ 4.6): fix in
  `packages/webapp/src/providers/claude-model-version.ts`, never at the
  call site. Both: `docs/pitfalls.md`.

## Conventions

- Two type systems: legacy `tools/` + pi-compatible `core/`; bridge via
  `tool-adapter.ts`.
- Logging: `createLogger('namespace')` (`base/logger.ts`).
- Extension detection: `isExtensionRealm()` from `base/runtime-env.ts`
  (re-export of `isChromeExtensionRealm`).
- Dual-mode: CLI and extension. The thin extension runs no dynamic code —
  realms, WASM, sprinkles/dips run in the hosted leader tab / kernel worker.
- Model IDs: pi-ai aliases (`claude-opus-4-6`), not dated snapshots.
- Per-cone model lives on the work-unit record (`modelFor` / `setUnitModel`).
  Picker changes only the selected cone. Seed (`scoops/model-seed.ts`) waits
  for an account. `docs/work-unit.md`.
- Provider merge: pi-ai → `modelOverrides` → `getModelIds()`. Filter:
  `packages/dev-tools/providers.build.json`.
- Tool-output images: parse `<img:data:…>` only in `base/image-markers.ts`.
- Agent-avatar host wiring: `docs/webapp-details.md`; channels:
  `docs/webcomponents-details.md`.
- Prefer absolute VFS paths (`/workspace/...`, `/shared/...`).
  `VirtualFS.create({ dbName, wipe })` for isolated tests. Mounts use
  `FileSystemDirectoryHandle` — do not copy large trees into IndexedDB
  unless you mean to. `fs.walk()` + `path-utils.ts`; `RestrictedFS` when
  code must not see the whole VFS.

## Layouts

See `docs/layouts.md`. Dock-tree persistence (`wireDockTreePersistence`) is
the pre-panel default; `panel-layouts` on replaces the dock with
`<slicc-layout>`.

## Frozen Sessions

See Frozen Sessions in `docs/webapp-details.md`. Export:
`docs/transcript-export.md`.

## Related

`docs/architecture.md`, `docs/secrets.md`,
[`packages/node-server/CLAUDE.md`](../node-server/CLAUDE.md).
