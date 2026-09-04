# CLAUDE.md

Browser app guide for `packages/webapp/`. `packages/webapp/src/` is the browser app core: VFS, shell, git, CDP, tools, providers, skills, scoops, and the UI. Extension-only behavior lives in `packages/chrome-extension/CLAUDE.md`; runtime/server details in float-specific guides.

## Architecture

Layer stack (each layer consumed by the next):

```text
Virtual Filesystem (fs/) → RestrictedFS → Shell (shell/) + Git (git/)
  → CDP (cdp/) → Tools (tools/) → Core Agent (core/)
    → Scoops Orchestrator (scoops/) → UI (ui/)
      → consumed by node-server and chrome-extension floats
```

Data flow and full subsystem maps: `docs/architecture.md`.

## Key Subsystems

Per-subsystem file paths + invariants live in
[`docs/webapp-details.md`](../../docs/webapp-details.md); root paths only here.

- Kernel host — `src/kernel/` (also `docs/kernel/process-model.md`)
- Orchestrator + tray — `src/scoops/`
- WorkUnit runtime (cone/scoop as roles) — `src/work-unit/` (also `docs/work-unit.md`)
- VirtualFS + mounts — `src/fs/` (also `docs/mounts.md`)
- Shell (`.jsh`/`.bsh`, MCP) — `src/shell/` (also `docs/shell-reference.md`)
- Speech (mic/TTS) — `src/speech/`
- CDP + cherry — `src/cdp/`
- Tools (file/`bash`/scoop helpers) — `src/tools/`; browser automation routes through shell
  commands, not a separate tool family
- Sudo — `src/sudo/` + `fs/sudo-fs.ts` + `shell/sudo/` (also `docs/approvals.md`)
- Bash progress overlay — `shell/progress/` (one `ScriptRun` per tool call;
  `docs/exploration/bash-progress-overlay.md`)
- Core agent — `src/core/` (pi-agent-core + pi-ai; `tool-adapter.ts` bridges legacy tools;
  feature flags + context compaction)
- UI + layouts — `src/ui/` and `ui/wc/` (also `docs/layouts.md`)
- Skills — `src/skills/`; Sprinkles + Dips — `ui/sprinkle-*.ts`, `ui/dip.ts`
- Stale-asset recovery — `setup-preload-error-reload.ts` + `stale-asset-channel.ts`
- Storage persistence — `boot/setup-storage-persistence.ts` (OPFS is _evictable_ best-effort
  storage; `navigator.storage.persist()` is the only opt-out and is page-realm only —
  `docs/pitfalls.md`)
- File mentions / preview + base64 payload chips —
  [`docs/webapp-details.md`](../../docs/webapp-details.md) (catches: confirm-then-linkify
  only, never a streaming bubble; `getMimeType()` SERVES vs `sniffFileType()` READS)

## Never-Rules

Invariants a reviewer must catch; mechanism in `docs/webapp-details.md` + the linked docs.

- **Kernel realms** (`docs/kernel/process-model.md`): `runInRealm()` spawns a per-task
  `DedicatedWorker` (SIGKILL → exit 137). Sync FS/`child_process.*Sync` from realm scripts go
  through `realm/sync-*` dispatchers + `ui/sync-fs-sw-handler.ts` with per-realm capability
  tokens — never bypass. SAB dispatchers only serve `Realm.isolatedThread`; never hand one to
  the in-process factory (self-deadlock).
- **Cone and scoop are roles over one `WorkUnit`** (`docs/work-unit.md`):
  `RegisteredScoop.parentJid` is required — `null` is THE root test (`isRootUnit`); no role
  field, so the compiler is the ratchet. A unit's CONVERSATION is the one canonical
  append-only record (history/UI/transcripts DERIVE from it); never make a canonical read
  fatal or delete a still-written legacy record. **Users never talk to a scoop**: a selected
  scoop is READ-ONLY (`isReadOnlyUnit`); its asks go to the OWNING cone. Layout from
  `workspaceFor` ALONE (never hardcode `/workspace`); memory per cone. Privileged float
  detection goes through `CapabilityBroker` at kernel-host composition (#2276), never
  `isExtensionRealm` in scoops/tools.
- **Scoop queue**: pure-lick batches defer while `ScoopContext.isBusy` without queue/
  watermark loss; user `web` bypasses the window. `transcript-limits.ts` caps bridge/event
  transcripts at 64 KB — never `agent-sessions` history or compaction input.
- **Agent bridge defaults** (`agent-bridge.ts`, `docs/webapp-details.md`): writable `[cwd,
/shared/, <scratch>/, /tmp/]`, visible child roots + `invokingCwd`; `--read-only` replaces.
  `--workspace-mode private` drops parent workspace, `/shared/`, and mount auto-inclusion
  (#2277); `/tmp/` stays ambient.
- **Mount signing is browser-naive** (`docs/mounts.md`): CLI → `/api/s3-sign-and-forward`,
  extension → SW. Never sign in the browser.
- **Shell/mount cache**: `script-catalog.ts` caches per `$PATH` root set; the `FsWatcher`
  cache is bypassed only for root sets a mount overlaps. `.jsh` lookup follows `$PATH`, never
  a full-VFS scan.
- **`typescript` v7 has no browser/WASM API** — use `typescript-js` (v6) for browser
  `tsc`/`test`/`esm-transpile`; `builtin-shadow-map.ts` is authoritative for `ipx`/`npx` →
  built-in redirects.
- **`esbuild.initialize` needs `worker: false` + a bounded wait** in every browser float
  (`worker: true` lets a blocked blob worker hang forever); never cache a load promise that
  can stay pending (`docs/pitfalls.md`).
- **Speech is page-realm only** (`docs/webapp-details.md`): mic/AudioContext; kernel worker
  bridges via `hear-*` panel-RPC and stubs the speech modules (`stubPageRealmSpeechPlugin`,
  else ~1.8 MB of models leak in). Extension `uiOnly` side panel: Chrome denies `getUserMedia`
  cross-origin, so `wc-follower.ts` skips `ptt` / "Take a photo".
- **Sprinkle element bundles ride the app's chunk graph** (`docs/webapp-details.md`):
  `<slicc-diff>` / `<slicc-editor>` are Rollup entries whose loader shims dynamic-import the
  hashed entry, so Shiki / `@pierre/diffs` / CM6 stay the app's chunks, not an eager copy.
- **Cherry** (`cherry-host-transport.ts`, `cherry-host-protocol.ts`; `docs/webapp-details.md`):
  trust parent origin from `location.ancestorOrigins[0]`, not `document.referrer`; envelope
  gate = origin allowlist + `MessageEvent.source` identity + per-mount `channelId` nonce.
  `packages/cherry/src/protocol.ts` mirrors it — keep in sync.
- **Sudo self-protection** (`docs/approvals.md`): writes to `/etc/sudoers` +
  `/etc/sudoers.d/*` + `/etc/APPROVALS.md` always require approval (hardcoded in
  `matchPath`). Their bundled defaults are seeded ungated by
  `SudoManager.ensureDefaults()` when absent — a self-protected file the upgrade
  merge has to CREATE would otherwise prompt for a no-op (#2686). Page realm can
  reassign `globalThis.confirm`, so `sudo/panel-responder.ts` captures natives at init and
  approval chrome mounts via `ui/wc/trusted-layer.ts`, never `document.body`. `reason` is a
  FIELD on a `deny`, never a fourth `decision` (a new variant fails open).
- **`/tmp` is granted to every scoop, sandbox or not** — `builtinScoopGrants()`
  (`base/sudoers.ts`) + `ALWAYS_WRITABLE_PREFIXES` (`fs/restricted-fs.ts`) gate
  independently, so change together. It is SHARED: never store a secret there; private
  scratch is `/scoops/<folder>/tmp`.
- **Frozen-session recovery** (`docs/work-unit.md`) uses the **bounded** legacy enrichment
  call, never the unbounded curator. Save / Skip memory / Erase clear the SELECTED cone's chat
  and non-mount `/tmp`, not scoops; root resolves via `ui/wc/wc-unit-context.ts`
  (`chatSessionIdFor`), never the literal `session-cone`.
- **Layouts** (`docs/layouts.md`, behind `panel-layouts` flag): `panelize-shell.ts`
  RE-PARENTS what `buildWcShellFrame` built, so keep `WcShellRefs` valid; `setPanelVisible` adds
  an unplaced panel but never duplicates a placed one.
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts` removes only
  `localStorage['slicc_cloud_managed']` providers, never user-added; `?connect=1` is
  login-only (no kernel).
- **Never monkeypatch a method on a get/set-asymmetric Proxy** (`docs/webapp-details.md`):
  the sudo-fs Proxy advertises `MONKEYPATCH_UNSAFE_FS`; reassigning a gated method OOMs the
  kernel worker via override↔wrapper recursion.
- **Provider quirks** (`docs/pitfalls.md`): attach the Adobe proxy's `X-Session-Id` header
  at the call site (`ensureSessionIdHeader` is defense-in-depth, not the fix). Claude Bedrock
  capability shims belong in `src/providers/claude-model-version.ts`, never at the call site.

## Key Conventions

- **Two type systems**: legacy `tools/` + pi-compatible `core/`; bridge via
  `tool-adapter.ts`. **Logging**: `createLogger('namespace')` (`base/logger.ts`).
  **Extension detection**: `isExtensionRealm()` (`base/runtime-env.ts`).
- **Tool-output images**: `<img:data:…>` markers are parsed in exactly one place
  (`base/image-markers.ts`) so every consumer agrees what is an image; marker-shaped prose
  and markers sliced mid-payload stay inert.
- **Markdown media in messages**: `![alt](path)` carries images, video AND audio —
  `base/message-media.ts` decides which element, and rewrites rooted VFS paths through `base/preview-url.ts`. A bare
  `/shared/x.png` in an `<img src>` hits the SPA fallback, which answers **200 + `text/html`**,
  so the element fails to decode with nothing logged; always route media through `/preview/*`.
  Video needs `video` in the DOMPurify allowlist (`ui/message-renderer.ts`) or it is deleted
  silently. `.shtml` refs are dips and must stay untouched for `hydrateDips()`.
- **Dual-mode compatibility**: features must work in both standalone/CLI and extension. The
  thin extension runs no dynamic code itself — realms, WASM, sprinkles/dips run in the hosted
  leader tab / kernel worker.
- **Agent-avatar expressions** (`ui/wc/wc-live-*.ts`): activity from descriptors, transients
  via host calls on `refs.switcher`. Channels: `docs/webcomponents-details.md`.
- **Model IDs**: pi-ai aliases such as `claude-opus-4-6`, not dated snapshots.
- **Per-cone model** (`docs/work-unit.md`): the model lives on the work-unit record, not page
  localStorage — read/write via `work-unit/record.ts` (`modelFor`/`setUnitModel` etc.). The
  picker changes ONLY the selected cone; global `selected-model` survives only as first-boot
  seed (`scoops/model-seed.ts`).
- **Provider composition** (`docs/webapp-details.md`): pi-ai auto-discovered +
  `src/providers/built-in/` + `providers/`, merged pi-ai → `modelOverrides` → `getModelIds()`;
  build filtering in `packages/dev-tools/providers.build.json`.

## VFS API Patterns

- Prefer absolute VFS paths (`/workspace/...`, `/shared/...`) + `fs.walk()`/`path-utils.ts`
  helpers over ad hoc path splitting. `RestrictedFS` is the boundary when code should not
  see the whole VFS.
- `VirtualFS.create({ dbName, wipe })` is the entry point for isolated testable instances.
- Mounted directories bridge directly to `FileSystemDirectoryHandle`; do not copy large
  trees into IndexedDB unless you mean to.

## Related Guides

- [`docs/webapp-details.md`](../../docs/webapp-details.md) — full subsystem detail
- `packages/chrome-extension/CLAUDE.md`, `packages/node-server/CLAUDE.md` — float guides
- Deep docs are cited inline above (architecture, shell-reference, mounts, process-model,
  approvals, layouts, work-unit, pitfalls).
