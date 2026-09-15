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

Per-subsystem paths + invariants: [`docs/webapp-details.md`](../../docs/webapp-details.md); root
paths only here.

- Kernel host — `src/kernel/` (also `docs/kernel/process-model.md`)
- Orchestrator + tray — `src/scoops/`; WorkUnit runtime (cone/scoop as roles) — `src/work-unit/`
  (also `docs/work-unit.md`)
- VirtualFS + mounts — `src/fs/` (also `docs/mounts.md`); Shell (`.jsh`/`.bsh`, MCP) — `src/shell/`
  (also `docs/shell-reference.md`)
- Speech (mic/TTS) — `src/speech/`; CDP + cherry — `src/cdp/`
- Tools (file/`bash`/scoop helpers) — `src/tools/`; browser automation routes through shell
  commands, not a separate tool family
- Core agent — `src/core/` (pi-agent-core + pi-ai; `tool-adapter.ts` bridges legacy tools)
- Sudo — `src/sudo/` + `fs/sudo-fs.ts` + `shell/sudo/` (also `docs/approvals.md`)
- Bash progress overlay — `shell/progress/` (`docs/exploration/bash-progress-overlay.md`)
- UI + layouts — `src/ui/` and `ui/wc/` (also `docs/layouts.md`)
- Keyboard mode — `ui/wc/wc-shortcuts.ts` + `wc-shortcut-*.ts` (help sections from `Command.group`,
  never the keymap; `docs/webapp-details.md`)
- Skills — `src/skills/`; Sprinkles + Dips — `ui/sprinkle-*.ts`, `ui/dip.ts`; stale-asset recovery
  — `setup-preload-error-reload.ts` + `stale-asset-channel.ts`
- Storage persistence — `boot/setup-storage-persistence.ts` (OPFS is _evictable_;
  `navigator.storage.persist()` is the only opt-out, page-realm only). OPFS read/preload invariants +
  fixtures in `docs/pitfalls.md`.
- File mentions / preview + base64 payload chips (`docs/webapp-details.md`): confirm-then-linkify
  only, never a streaming bubble (`getMimeType()` SERVES vs `sniffFileType()` READS).

## Never-Rules

Invariants a reviewer must catch; mechanism in the linked docs.

- **Kernel realms** (`docs/kernel/process-model.md`): `runInRealm()` spawns a per-task
  `DedicatedWorker` (SIGKILL → exit 137). Sync FS/`child_process.*Sync` route through `realm/sync-*` +
  `ui/sync-fs-sw-handler.ts` with per-realm capability tokens — never bypass.
- **`/tmp` is granted to every scoop, sandbox or not** — `builtinScoopGrants()` (`base/sudoers.ts`) +
  `ALWAYS_WRITABLE_PREFIXES` (`fs/restricted-fs.ts`) gate independently, so change together. SHARED:
  never store secrets; private scratch is `/scoops/<folder>/tmp`.
- **Cone and scoop are roles over one `WorkUnit`** — see `docs/work-unit.md` (canonical for the
  record/marker model): `RegisteredScoop.parentJid` required, `null` is THE root test
  (`isRootUnit`), no role field. The CONVERSATION is the one canonical append-only record
  (history/UI/transcripts DERIVE) — never break its rules (canonical-read fallback, markers ≠
  entries, SETTLED-only persistence, error cards are assistant rows). **Users never talk to a
  scoop**: a selected scoop is READ-ONLY (`isReadOnlyUnit`); asks go to the OWNING cone. Layout
  from `workspaceFor` ALONE (never `/workspace`); memory per cone. Privileged-float
  detection via `CapabilityBroker`, not `isExtensionRealm`, in scoops.
- **Frozen-session recovery** (`docs/work-unit.md`) uses the **bounded** legacy enrichment call,
  never the unbounded curator. Save / Skip memory / Erase clear the SELECTED cone's chat + non-mount
  `/tmp`, not scoops (root via `wc-unit-context.ts` `chatSessionIdFor`).
- **Scoop queue** (`docs/webapp-details.md`): pure-lick batches defer while `ScoopContext.isBusy`
  without queue/watermark loss; user `web` bypasses the window. `transcript-limits.ts` caps
  bridge/event transcripts at 64 KB (never `agent-sessions`/compaction).
- **Agent bridge defaults** (`agent-bridge.ts`, `docs/webapp-details.md` — canonical for the writable
  set): `--read-only` replaces; `--workspace-mode private` drops parent workspace + `/shared/` +
  mounts (`/tmp/` stays).
- **Mount signing is browser-naive** (`docs/mounts.md`): CLI → `/api/s3-sign-and-forward`,
  extension → SW; never sign in the browser.
- **Shell/mount cache**: `script-catalog.ts` caches per `$PATH` root set; `FsWatcher` cache is
  bypassed only for root sets a mount overlaps.
- **`typescript` v7 has no browser/WASM API** (`docs/webapp-details.md`) — use `typescript-js` (v6)
  for browser `tsc`/`test`/`esm-transpile`; `builtin-shadow-map.ts` owns `ipx`/`npx`.
- **`esbuild.initialize` needs `worker: false` + a bounded wait** in every browser float
  (`docs/pitfalls.md`); `worker: true` hangs forever; never cache a pending-able promise.
- **Speech is page-realm only** (`docs/webapp-details.md`): mic/AudioContext; kernel worker bridges
  via `hear-*` panel-RPC. Extension `uiOnly` side panel — Chrome denies cross-origin `getUserMedia`,
  so `wc-follower.ts` skips `ptt`/photo.
- **Sprinkle element bundles ride the app's chunk graph** (`docs/webapp-details.md`):
  `<slicc-diff>`/`<slicc-editor>` loader shims dynamic-import the hashed Rollup entry.
- **Cherry** (`cherry-host-{transport,protocol}.ts`; `docs/webapp-details.md`): trust parent origin
  from `location.ancestorOrigins[0]`, not `document.referrer`; envelope gate = origin allowlist +
  `MessageEvent.source` + per-mount `channelId` nonce; keep `packages/cherry/src/protocol.ts` synced.
- **Never monkeypatch a get/set-asymmetric Proxy method** (`docs/webapp-details.md`): the sudo-fs
  Proxy (`MONKEYPATCH_UNSAFE_FS`) OOMs the kernel worker if a gated method is reassigned.
- **Sudo self-protection** (`docs/approvals.md`): writes to `/etc/sudoers`, `/etc/sudoers.d/*`,
  `/etc/APPROVALS.md` always require approval (hardcoded in `matchPath`). `sudo/panel-responder.ts`
  captures native `confirm` at init; approval chrome mounts via `ui/wc/trusted-layer.ts`; `reason` is
  a FIELD on `deny`, not a `decision`.
- **Policy is read from `/etc` ONLY** (`docs/approvals.md`): a sudoers-shaped path inside a scoop
  sandbox (`/scoops/<f>/etc/sudoers`) is REFUSED, not prompted — an approver must never be offered
  the chance to let a scoop author its own authority. Per-scoop "Always" grants live in
  `/etc/sudoers.d/scoop-<folder>`; `doReload` filters `scoop-*` OUT of the global merge and
  `getPolicyForScoop` loads it for its own scoop, so keep those two in sync.
- **Layouts** (`docs/layouts.md`, behind `panel-layouts` flag): `panelize-shell.ts` RE-PARENTS
  `buildWcShellFrame`'s output — keep `WcShellRefs` valid; `setPanelVisible` adds an unplaced
  panel, never duplicates a placed one.
- **Line diff memory** (`git/diff.ts`, `docs/webapp-details.md`): keep Myers scratch storage linear
  in input lines (diff/stat/merge-file share it); preserve shortest edit paths for merge alignment.
- **Provider quirks** (`docs/pitfalls.md`): attach the Adobe proxy's `X-Session-Id` at the call
  site; Claude Bedrock capability shims live in `providers/claude-model-version.ts`, not the call
  site; OpenRouter (Free) is `providers/openrouter-free.ts` (`docs/oauth-intercept.md`).
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts` removes only
  `localStorage['slicc_cloud_managed']` providers (not user-added); `?connect=1` is login-only.

## Key Conventions

- **Logging**: `createLogger('namespace')` (`base/logger.ts`). **Extension detection**:
  `isExtensionRealm()` (`base/runtime-env.ts`). Legacy `tools/` ↔ pi `core/` bridge:
  `tool-adapter.ts`.
- **Tool-output images**: `<img:data:…>` markers are parsed only in `base/image-markers.ts`
  (marker-shaped prose + mid-payload slices stay inert).
- **Markdown media in messages** (`docs/webapp-details.md`): `![alt](path)` carries image/video/audio
  via `base/message-media.ts`. Always route media through `/preview/*` (a bare `/shared/x.png`
  `<img src>` silently decodes to nothing); `video` needs the DOMPurify allowlist; `.shtml` = dips.
- **Dual-mode compatibility**: features must work in standalone/CLI and extension. The thin
  extension runs no dynamic code — realms, WASM, sprinkles/dips run in the hosted leader tab /
  kernel worker.
- **Agent-avatar expressions** (`ui/wc/wc-live-*.ts`; channels in `docs/webcomponents-details.md`):
  activity from descriptors, transients via host calls on `refs.switcher`.
- **Model IDs**: pi-ai aliases such as `claude-opus-4-6`, not dated snapshots.
- **Per-cone model** (`docs/work-unit.md`): the model lives on the work-unit record, not page
  localStorage — read/write via `work-unit/record.ts` (`modelFor`/`setUnitModel`). The picker
  changes ONLY the selected cone; global `selected-model` is a first-boot seed.
- **Provider composition** (`docs/webapp-details.md`): pi-ai auto-discovered +
  `src/providers/built-in/` + `providers/`, merged pi-ai → `modelOverrides` → `getModelIds()`; build
  filter `packages/dev-tools/providers.build.json`.
- **Budget-mode cost surfaces** (`docs/webapp-details.md` — canonical): a provider on a rolling
  allowance implements `getBudgetUsage()`; cost surfaces headline percent **USED**, not `$` (no
  hook → `$`).

## VFS API Patterns

- Prefer absolute VFS paths (`/workspace/...`, `/shared/...`) + `fs.walk()`/`path-utils.ts` over ad
  hoc splitting. `RestrictedFS` is the boundary when code should not see the whole VFS;
  `VirtualFS.create({ dbName, wipe })` makes isolated testable instances.
- Mounted dirs bridge directly to `FileSystemDirectoryHandle`; don't copy large trees into
  IndexedDB unless you mean to.

## Related Guides

[`docs/webapp-details.md`](../../docs/webapp-details.md) (full subsystem detail); float guides
`packages/chrome-extension/CLAUDE.md` + `packages/node-server/CLAUDE.md`.
