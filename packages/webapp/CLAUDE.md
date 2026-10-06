# CLAUDE.md

Browser app core (`src/`). Extension-only: `packages/chrome-extension/CLAUDE.md`.

## Architecture

Layer stack (each consumed by the next); data flow + maps in `docs/architecture.md`:

```text
Virtual Filesystem (fs/) → RestrictedFS → Shell (shell/) + Git (git/)
  → CDP (cdp/) → Tools (tools/) → Core Agent (core/)
    → Scoops Orchestrator (scoops/) → UI (ui/) → node-server + chrome-extension floats
```

## Key Subsystems

Paths + invariants: [`docs/webapp-details.md`](../../docs/webapp-details.md); root paths only.

- Kernel host — `src/kernel/` (`docs/kernel/process-model.md`)
- Computers — `src/computers/` (unranked; protocol + adapters in `docs/computer-protocol.md`); page store
  `ui/computers-store.ts`, overlay rows `ui/wc/wc-computers.ts`
- Orchestrator + tray — `src/scoops/`; WorkUnit runtime (cone/scoop as roles) — `src/work-unit/`
  (`docs/work-unit.md`)
- VirtualFS + mounts — `src/fs/` (`docs/mounts.md`); Shell (`.jsh`/`.bsh`, MCP) — `src/shell/`
  (`docs/shell-reference.md`)
- Speech (mic/TTS) — `src/speech/`; CDP + cherry — `src/cdp/`
- Tools (file/`bash`/scoop helpers) — `src/tools/`; browser automation routes through shell, not a tool
  family
- Core agent — `src/core/` (pi-agent-core + pi-ai; `tool-adapter.ts` bridges legacy tools)
- Sudo — `src/sudo/` + `fs/sudo-fs.ts` + `shell/sudo/` (`docs/approvals.md`); Bash progress overlay —
  `shell/progress/` (`docs/exploration/bash-progress-overlay.md`)
- UI + layouts — `src/ui/` and `ui/wc/` (`docs/layouts.md`)
- Keyboard mode — `ui/wc/wc-shortcuts.ts` + `wc-shortcut-*.ts` (help from `Command.group`, not keymap)
- Skills — `src/skills/`; Sprinkles + Dips — `ui/sprinkle-*.ts`, `ui/dip.ts`; stale-asset recovery —
  `setup-preload-error-reload.ts` + `stale-asset-channel.ts`
- Storage persistence — `boot/setup-storage-persistence.ts` (OPFS is _evictable_;
  `navigator.storage.persist()` is the only opt-out, page-realm only; `docs/pitfalls.md`)
- File mentions / preview + base64 payload chips: confirm-then-linkify only, never a streaming bubble
  (`getMimeType()` SERVES vs `sniffFileType()` READS)
- Mention previews — `ui/mention-previews.ts` + `ui/wc/wire-mention-previews.ts`: links fetch on hover;
  questions use the lazy `gpu-ask.js` worker, answers become a `question` lick

## Never-Rules

- **Kernel realms** (`docs/kernel/process-model.md`): `runInRealm()` spawns a per-task `DedicatedWorker`
  (SIGKILL → exit 137). Sync FS/`child_process.*Sync` route through `realm/sync-*` +
  `ui/sync-fs-sw-handler.ts` with per-realm capability tokens — never bypass.
- **`/tmp` is granted to every scoop, sandbox or not** — `builtinScoopGrants()` (`base/sudoers.ts`) +
  `ALWAYS_WRITABLE_PREFIXES` (`fs/restricted-fs.ts`) gate independently, so change together. SHARED, so
  no secrets; private scratch is `/scoops/<folder>/tmp`.
- **Cone and scoop are roles over one `WorkUnit`** (`docs/work-unit.md`, canonical for record/marker
  model): `RegisteredScoop.parentJid` required, `null` is THE root test (`isRootUnit`), no role field.
  The CONVERSATION is the canonical append-only record (history/UI/transcripts DERIVE; legacy stores
  frozen) — never break its rules (markers ≠ entries, SETTLED-only persistence, error cards are `error`
  markers). **Users never talk to a scoop**: a selected scoop is READ-ONLY (`isReadOnlyUnit`), asks go to
  the OWNING cone. Layout from `workspaceFor` ALONE (never `/workspace`); memory per cone. Privileged-float
  detection via `CapabilityBroker`, not `isExtensionRealm`.
- **Frozen-session recovery** (`docs/work-unit.md`) uses the **bounded** legacy enrichment call, not the
  unbounded curator. Save / Skip memory / Erase clear the SELECTED cone's chat + non-mount `/tmp` (not
  scoops; root cone via `wc-unit-context.ts`). `/sessions/index.json` writers go through
  `serializeIndexWrite` and update only rows still present (only a freeze creates rows); deleting a
  frozen chat removes its files first and the row LAST (`ui/frozen-session-delete.ts`).
- **Scoop queue**: pure-lick batches defer while `ScoopContext.isBusy` without queue/watermark loss; user
  `web` bypasses the window. `transcript-limits.ts` caps bridge/event transcripts at 64 KB (not
  `agent-sessions`/compaction).
- **Agent bridge defaults** (`agent-bridge.ts`; writable set in `docs/webapp-details.md`): `--read-only`
  replaces; `--workspace-mode private` drops parent workspace + `/shared/` + mounts (`/tmp/` stays).
- **Mount signing is browser-naive** (`docs/mounts.md`): CLI → `/api/s3-sign-and-forward`, extension →
  SW, never the browser.
- **Shell/mount cache**: `script-catalog.ts` caches per `$PATH` root set; `FsWatcher` cache bypassed only
  at mount overlaps.
- **`typescript` v7 has no browser/WASM API** — use `typescript-js` (v6) for browser
  `tsc`/`tst`/`esm-transpile`; `builtin-shadow-map.ts` owns `ipx`/`npx`.
- **`esbuild.initialize` needs `worker: false` + a bounded wait** in every browser float
  (`docs/pitfalls.md`); `worker: true` hangs; never cache a pending-able promise.
- **Speech is page-realm only**: mic/AudioContext; kernel worker bridges via `hear-*` panel-RPC. Chrome
  denies cross-origin `getUserMedia` in the extension side panel; `wc-follower.ts` skips `ptt`/photo.
- **Sprinkle element bundles ride the app's chunk graph**: `<slicc-diff>`/`<slicc-editor>` loader shims
  dynamic-import the hashed Rollup entry.
- **Line diff memory** (`git/diff.ts`): keep Myers scratch storage linear in input lines
  (diff/stat/merge-file share it); keep shortest edit paths for merges.
- **Cherry** (`cherry-host-{transport,protocol}.ts`): trust parent origin from
  `location.ancestorOrigins[0]`, not `document.referrer`; envelope gate = origin allowlist +
  `MessageEvent.source` + per-mount `channelId` nonce; keep `packages/cherry/src/protocol.ts` in sync.
- **Never monkeypatch a get/set-asymmetric Proxy method**: the sudo-fs Proxy (`MONKEYPATCH_UNSAFE_FS`)
  OOMs the kernel worker if a gated method is reassigned.
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts` removes only
  `slicc_cloud_managed` providers (not user-added); `?connect=1` = login-only.
- **Sudo self-protection + `/etc`-only policy** (`docs/approvals.md`, canonical): writes to
  `/etc/sudoers`, `/etc/sudoers.d/*`, `/etc/APPROVALS.md` always require approval (hardcoded in
  `matchPath`); `sudo/panel-responder.ts` captures native `confirm` at init, chrome via
  `ui/wc/trusted-layer.ts`. A sudoers-shaped path in a scoop sandbox (`/scoops/<f>/etc/sudoers`) is
  REFUSED, not prompted — never let a scoop author its own authority. Per-scoop grants
  (`/etc/sudoers.d/scoop-<folder>`) stay OUT of the global merge, loaded per-scoop by
  `getPolicyForScoop`.
- **Layouts** (`docs/layouts.md`, behind `panel-layouts` flag): `panelize-shell.ts` RE-PARENTS
  `buildWcShellFrame` output — keep `WcShellRefs` valid; `setPanelVisible` adds an unplaced panel, never a
  placed one.
- **Provider quirks** (`docs/pitfalls.md`): Adobe proxy's `X-Session-Id` attaches at the call site;
  Claude Bedrock shims in `providers/claude-model-version.ts`; OpenRouter (Free) in
  `providers/openrouter-free.ts` (`docs/oauth-intercept.md`).
- **Provider budget failures**: `core/error-families.ts` is the shared Adobe/Grok exhausted-budget
  classifier (retries/cards/transcripts/telemetry); plain 429s stay transient. Mirror
  `Models/ErrorFamilies.swift`.

## Key Conventions

- **Logging**: `createLogger('namespace')` (`base/logger.ts`). **Extension detection**:
  `isExtensionRealm()` (`base/runtime-env.ts`).
- **Tool-output images**: `<img:data:…>` markers parsed only in `base/image-markers.ts` (marker-shaped
  prose + mid-payload slices inert).
- **Markdown media in messages**: `![alt](path)` carries image/video/audio via `base/message-media.ts`.
  Route through `/preview/*` (a bare `/shared/x.png` `<img src>` decodes to nothing); `video` needs the
  DOMPurify allowlist; `.shtml` = dips.
- **Agent-avatar expressions** (`ui/wc/wc-live-*.ts`; channels in `docs/webcomponents-details.md`):
  activity from descriptors, transients via `refs.switcher`.
- **`no-default-skills`** (off; `docs/feature-flags.md`): when on, unit init, filesystem reset, and
  `upgrade apply` don't seed bundled `/workspace/skills` (`/shared` + `/etc` still seed); prompt index is
  `loadSkills` of what's on disk. `flags set no-default-skills on|off` persists the override.
- **Per-cone model** (`docs/work-unit.md`): the model lives on the work-unit record, not page
  localStorage — read/write via `work-unit/record.ts` (`modelFor`/`setUnitModel`). The picker changes
  ONLY the selected cone; global `selected-model` is a first-boot seed.
- **Provider composition**: pi-ai auto-discovered + `src/providers/built-in/` + `providers/`, merged
  pi-ai → `modelOverrides` → `getModelIds()`; filter `packages/dev-tools/providers.build.json`. Read via
  `core/model-catalog.ts` (pi.dev overlay), never pi-ai's `getModels`
  ([live model catalogue](../../docs/webapp-details.md#live-model-catalogue)).
- **Budget-mode cost surfaces**: a provider on a rolling allowance implements `getBudgetUsage()`; cost
  surfaces headline percent **USED**, not `$` (no hook → `$`).

## VFS API Patterns

- Prefer absolute VFS paths (`/workspace/...`, `/shared/...`) + `fs.walk()`/`path-utils.ts` over ad hoc
  splitting. `RestrictedFS` bounds what code can see; `VirtualFS.create({ dbName, wipe })` makes isolated
  test instances.
- Mounted dirs bridge directly to `FileSystemDirectoryHandle`; don't copy large trees to IndexedDB.

## Related Guides

Floats: `packages/chrome-extension/CLAUDE.md`, `packages/node-server/CLAUDE.md`.
