# CLAUDE.md

Browser app guide for `packages/webapp/`; `src/` is the app core. Extension-only behavior: `packages/chrome-extension/CLAUDE.md`.

## Architecture

Layer stack (each consumed by the next); data flow + subsystem maps in `docs/architecture.md`:

```text
Virtual Filesystem (fs/) → RestrictedFS → Shell (shell/) + Git (git/)
  → CDP (cdp/) → Tools (tools/) → Core Agent (core/)
    → Scoops Orchestrator (scoops/) → UI (ui/)
      → consumed by node-server and chrome-extension floats
```

## Key Subsystems

Per-subsystem file paths + invariants live in
[`docs/webapp-details.md`](../../docs/webapp-details.md); root paths only here.

- Kernel host — `src/kernel/` (also `docs/kernel/process-model.md`)
- Orchestrator + tray — `src/scoops/`; WorkUnit runtime (cone/scoop as roles) —
  `src/work-unit/` (also `docs/work-unit.md`)
- VirtualFS + mounts — `src/fs/` (also `docs/mounts.md`); Shell (`.jsh`/`.bsh`, MCP) —
  `src/shell/` (also `docs/shell-reference.md`)
- Speech (mic/TTS) — `src/speech/`; CDP + cherry — `src/cdp/`
- Tools (file/`bash`/scoop helpers) — `src/tools/`; browser automation routes through shell
  commands, not a separate tool family
- Core agent — `src/core/` (pi-agent-core + pi-ai; `tool-adapter.ts` bridges legacy tools)
- Sudo — `src/sudo/` + `fs/sudo-fs.ts` + `shell/sudo/` (also `docs/approvals.md`)
- Bash progress overlay — `shell/progress/` (`docs/exploration/bash-progress-overlay.md`)
- UI + layouts — `src/ui/` and `ui/wc/` (also `docs/layouts.md`)
- Keyboard mode (`docs/webapp-details.md`) — `ui/wc/wc-shortcuts.ts` + `wc-shortcut-*.ts`. Help
  sections come from `Command.group`, never the keymap.
- Skills — `src/skills/`; Sprinkles + Dips — `ui/sprinkle-*.ts`, `ui/dip.ts`; stale-asset
  recovery — `setup-preload-error-reload.ts` + `stale-asset-channel.ts`
- Storage persistence — `boot/setup-storage-persistence.ts` (OPFS is _evictable_;
  `navigator.storage.persist()` is the only opt-out, page-realm only — `docs/pitfalls.md`)
- OPFS snapshot reads — the ZenFS patch reacquires a File for at most three byte-read
  attempts on native `NotReadableError`; preserve other errors (`docs/pitfalls.md`).
  Real-browser fixture: `tests/e2e/zenfs-opfs-read-race/`.
- File mentions / preview + base64 payload chips —
  [`docs/webapp-details.md`](../../docs/webapp-details.md) (confirm-then-linkify only, never a
  streaming bubble; `getMimeType()` SERVES vs `sniffFileType()` READS)

## Never-Rules

Invariants a reviewer must catch; mechanism in the linked docs.

- **Kernel realms** (`docs/kernel/process-model.md`): `runInRealm()` spawns a per-task
  `DedicatedWorker` (SIGKILL → exit 137). Sync FS/`child_process.*Sync` from realm scripts go
  through `realm/sync-*` dispatchers + `ui/sync-fs-sw-handler.ts` with per-realm capability
  tokens — never bypass; SAB dispatchers serve only `Realm.isolatedThread`.
- **Cone and scoop are roles over one `WorkUnit`** (`docs/work-unit.md`):
  `RegisteredScoop.parentJid` required — `null` is THE root test (`isRootUnit`); no role field.
  The CONVERSATION is the one canonical append-only record (history/UI/transcripts DERIVE from
  it); never make a canonical read fatal or delete a still-written legacy record. A transcript row
  that annotates the conversation instead of belonging to it (the compaction seam) is a
  `record.markers` entry, NEVER a `ConversationEntry` — compaction replaces entries wholesale and
  would erase the row announcing it. Only a SETTLED round is written down (the phase stream does
  not replay, so a persisted in-flight seam could never be settled), under the row id the KERNEL
  minted and the wire carried. **Users never
  talk to a scoop**: a selected scoop is READ-ONLY (`isReadOnlyUnit`); asks go to the OWNING
  cone. Layout from `workspaceFor` ALONE (never hardcode `/workspace`); memory per cone.
  Privileged-float detection via `CapabilityBroker`, not `isExtensionRealm`, in scoops.
- **Scoop queue** (`docs/webapp-details.md`): pure-lick batches defer while `ScoopContext.isBusy`
  without queue/watermark loss; user `web` bypasses the window. `transcript-limits.ts` caps
  bridge/event transcripts at 64 KB, never `agent-sessions` or compaction.
- **Agent bridge defaults** (`agent-bridge.ts`, `docs/webapp-details.md`): writable `[cwd,
/shared/, <scratch>/, /tmp/]`, visible child roots + `invokingCwd`; `--read-only` replaces;
  `--workspace-mode private` drops parent workspace + `/shared/` + mounts (`/tmp/` stays).
- **Mount signing is browser-naive** (`docs/mounts.md`): CLI → `/api/s3-sign-and-forward`,
  extension → SW. Never sign in the browser.
- **Shell/mount cache**: `script-catalog.ts` caches per `$PATH` root set; `FsWatcher` cache is
  bypassed only for root sets a mount overlaps. `.jsh` lookup follows `$PATH`, not a full scan.
- **`typescript` v7 has no browser/WASM API** — use `typescript-js` (v6) for browser
  `tsc`/`test`/`esm-transpile`; `builtin-shadow-map.ts` is authoritative for `ipx`/`npx`
  redirects.
- **`esbuild.initialize` needs `worker: false` + a bounded wait** in every browser float
  (`docs/pitfalls.md`); `worker: true` can hang forever; never cache a promise that can stay
  pending.
- **Speech is page-realm only** (`docs/webapp-details.md`): mic/AudioContext; kernel worker
  bridges via `hear-*` panel-RPC and stubs speech modules. Extension `uiOnly` side panel: Chrome
  denies cross-origin `getUserMedia`, so `wc-follower.ts` skips `ptt` / photo capture.
- **Sprinkle element bundles ride the app's chunk graph** (`docs/webapp-details.md`):
  `<slicc-diff>` / `<slicc-editor>` loader shims dynamic-import the hashed Rollup entry, so
  Shiki / `@pierre/diffs` / CM6 stay app chunks.
- **Cherry** (`cherry-host-{transport,protocol}.ts`; `docs/webapp-details.md`): trust parent
  origin from `location.ancestorOrigins[0]`, not `document.referrer`; envelope gate = origin
  allowlist + `MessageEvent.source` identity + per-mount `channelId` nonce. Keep the mirror
  `packages/cherry/src/protocol.ts` in sync.
- **Sudo self-protection** (`docs/approvals.md`): writes to `/etc/sudoers`, `/etc/sudoers.d/*`,
  `/etc/APPROVALS.md` always require approval (hardcoded in `matchPath`). Page realm can reassign
  `globalThis.confirm`, so `sudo/panel-responder.ts` captures natives at init; approval chrome
  mounts via `ui/wc/trusted-layer.ts`, not `document.body`. `reason` is a FIELD on `deny`, not a
  fourth `decision`.
- **`/tmp` is granted to every scoop, sandbox or not** — `builtinScoopGrants()`
  (`base/sudoers.ts`) + `ALWAYS_WRITABLE_PREFIXES` (`fs/restricted-fs.ts`) gate independently, so
  change together. It is SHARED: never store secrets; private scratch is `/scoops/<folder>/tmp`.
- **OPFS startup reads** (`docs/pitfalls.md`): keep the ZenFS preload cap across the whole tree; cancel queued copies on failure and drain active copies; the sync cache is required. Browser reproduction: `tests/e2e/zenfs-preload/`.
- **Frozen-session recovery** (`docs/work-unit.md`) uses the **bounded** legacy enrichment call,
  never the unbounded curator. Save / Skip memory / Erase clear the SELECTED cone's chat +
  non-mount `/tmp`, not scoops; root via `wc-unit-context.ts` (`chatSessionIdFor`), never literal
  `session-cone`.
- **Layouts** (`docs/layouts.md`, behind `panel-layouts` flag): `panelize-shell.ts` RE-PARENTS
  what `buildWcShellFrame` built, so keep `WcShellRefs` valid; `setPanelVisible` adds an unplaced
  panel but never duplicates a placed one.
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts` removes only
  `localStorage['slicc_cloud_managed']` providers, not user-added; `?connect=1` is login-only.
- **Never monkeypatch a method on a get/set-asymmetric Proxy** (`docs/webapp-details.md`): the
  sudo-fs Proxy advertises `MONKEYPATCH_UNSAFE_FS`; reassigning a gated method OOMs the worker.
- **Provider quirks** (`docs/pitfalls.md`): attach the Adobe proxy's `X-Session-Id` at the call
  site (`ensureSessionIdHeader` is defense-in-depth). Claude Bedrock capability shims belong in
  `providers/claude-model-version.ts`, never the call site. OpenRouter (Free)
  (`providers/openrouter-free.ts`) filters the shared OpenRouter catalog to currently free
  vision+tools models — see `docs/oauth-intercept.md`.

## Key Conventions

- **Two type systems**: legacy `tools/` + pi-compatible `core/`, bridged via `tool-adapter.ts`.
  **Logging**: `createLogger('namespace')` (`base/logger.ts`). **Extension detection**:
  `isExtensionRealm()` (`base/runtime-env.ts`).
- **Tool-output images**: `<img:data:…>` markers are parsed in one place
  (`base/image-markers.ts`); marker-shaped prose and mid-payload slices stay inert.
- **Markdown media in messages** (`docs/webapp-details.md`): `![alt](path)` carries images,
  video AND audio via `base/message-media.ts`. Always route media through `/preview/*` (a bare
  `/shared/x.png` `<img src>` hits the SPA fallback and decodes silently to nothing); `video`
  needs the DOMPurify allowlist; `.shtml` are dips.
- **Dual-mode compatibility**: features must work in standalone/CLI and extension. The thin
  extension runs no dynamic code — realms, WASM, sprinkles/dips run in the hosted leader tab /
  kernel worker.
- **Agent-avatar expressions** (`ui/wc/wc-live-*.ts`): activity from descriptors, transients via
  host calls on `refs.switcher`. Channels: `docs/webcomponents-details.md`.
- **Model IDs**: pi-ai aliases such as `claude-opus-4-6`, not dated snapshots.
- **Per-cone model** (`docs/work-unit.md`): the model lives on the work-unit record, not page
  localStorage — read/write via `work-unit/record.ts` (`modelFor`/`setUnitModel`). The picker
  changes ONLY the selected cone; global `selected-model` is only a first-boot seed.
- **Provider composition** (`docs/webapp-details.md`): pi-ai auto-discovered +
  `src/providers/built-in/` + `providers/`, merged pi-ai → `modelOverrides` → `getModelIds()`;
  build filter in `packages/dev-tools/providers.build.json`.
- **Budget-mode cost surfaces** (`docs/webapp-details.md`): a provider on a rolling allowance
  implements `getBudgetUsage()` and every cost surface headlines percent **USED** of the window
  instead of `$`. `null` = no budget (30-min re-probe), THROW = failed call (5-min retry); the
  facade attaches a cached snapshot and never awaits the network past a session's first pull.
  No hook → today's `$` headline, untouched. `cost --json` is `{budget, scoops}`.

## VFS API Patterns

- Prefer absolute VFS paths (`/workspace/...`, `/shared/...`) + `fs.walk()`/`path-utils.ts`
  helpers over ad hoc splitting. `RestrictedFS` is the boundary when code should not see the
  whole VFS. `VirtualFS.create({ dbName, wipe })` makes isolated testable instances.
- Mounted dirs bridge directly to `FileSystemDirectoryHandle`; don't copy large trees into
  IndexedDB unless you mean to.

## Related Guides

[`docs/webapp-details.md`](../../docs/webapp-details.md) (full subsystem detail);
`packages/chrome-extension/CLAUDE.md` + `packages/node-server/CLAUDE.md` (float guides).
