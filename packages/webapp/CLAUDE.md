# CLAUDE.md

Browser app guide for `packages/webapp/`. Extension-only behavior lives in `packages/chrome-extension/CLAUDE.md`; runtime/server details in float-specific guides.

## Scope

`packages/webapp/src/` contains the browser app core: VFS, shell, git, CDP, tools, providers, skills, scoops, and the UI.

## Architecture

### Layer Stack

```text
Virtual Filesystem (fs/) → RestrictedFS → Shell (shell/) + Git (git/)
  → CDP (cdp/) → Tools (tools/) → Core Agent (core/)
    → Scoops Orchestrator (scoops/) → UI (ui/)
      → consumed by node-server and chrome-extension floats
```

### Data Flow

```text
User → ChatPanel → Orchestrator → ScoopContext.prompt() → pi-agent-core → LLM API
  → tool calls → RestrictedFS / AlmostBashShell / BrowserAPI
  → results → agent loop → UI updates / scoop routing
```

## Key Subsystems

Per-subsystem file paths + non-obvious invariants live in
[`docs/webapp-details.md`](../../docs/webapp-details.md). Root paths only here; the
never-rules below flag what a reviewer must recognise.

- Kernel host — `packages/webapp/src/kernel/` (also `docs/kernel/process-model.md`)
- Orchestrator + tray — `packages/webapp/src/scoops/`
- VirtualFS + mounts — `packages/webapp/src/fs/` (also `docs/mounts.md`)
- Shell (`.jsh`/`.bsh`, MCP) — `packages/webapp/src/shell/`
  (also `docs/shell-reference.md`)
- Speech (mic/TTS) — `packages/webapp/src/speech/`
- CDP + cherry — `packages/webapp/src/cdp/`
- Tools (file/`bash`/scoop helpers) — `packages/webapp/src/tools/`; browser
  automation routes through shell commands, not a separate tool family
- Sudo — `packages/webapp/src/sudo/` + `fs/sudo-fs.ts` + `shell/sudo/`
  (also `docs/approvals.md`)
- Core agent — `packages/webapp/src/core/` (pi-agent-core + pi-ai;
  `tool-adapter.ts` bridges legacy tools; feature flags, context compaction)
- UI + layouts — `packages/webapp/src/ui/` and `ui/wc/` (also `docs/layouts.md`)
- Skills — `packages/webapp/src/skills/`
- Sprinkles + Dips — `ui/sprinkle-*.ts`, `ui/dip.ts`
- Stale-asset recovery — `setup-preload-error-reload.ts` + `stale-asset-channel.ts`

## File mentions + preview

Clicking a file name the agent wrote in chat. Four modules, deliberately split so the guessing and the verifying stay separate:

- `core/file-mentions.ts` — the heuristic. Pure; finds CANDIDATES in prose and knows nothing about the VFS.
- `core/file-mention-resolver.ts` — checks candidates against the VFS via a lazily built, bounded basename index.
- `ui/file-mention-linker.ts` — walks a rendered message and links only what resolved.
- `ui/wc/wire-file-mentions.ts` — lifecycle: observes the thread, waits for streaming to finish, opens the preview.

Plus `core/file-type.ts` (content sniffing) and `ui/git-preview-source.ts` (the HEAD blob for diff mode). `ui/wc/file-actions.ts` owns `openFilePreview`, the single entry point both the file tree and a clicked mention go through.

Non-obvious rules:

- **Confirm, then linkify.** Nothing is decorated optimistically — the heuristic is permissive precisely BECAUSE verification gates it. A candidate that does not resolve stays plain text.
- **Never linkify a streaming bubble.** A half-arrived path resolves to nothing; bubbles are processed only once `streaming` clears.
- **`getMimeType()` (`core/mime-types.ts`) is for SERVING, `sniffFileType()` (`core/file-type.ts`) is for READING.** Never swap them: sniffing a type you then put in a `Content-Type` header is how MIME-confusion bugs happen, and serving's conservative `application/octet-stream` fallback is exactly what made `.jsh` unpreviewable. Precedence is magic bytes → extension → UTF-8 decodability.
- **`isomorphic-git` is imported lazily** in `git-preview-source.ts`; the UI layer must not pull the `src/git/` stack for a preview. Its fs shim is read-only ON PURPOSE — a preview surface must never be able to write to a repo.
- **The mention resolver's index is bounded** (`maxEntries`, `maxDepth`, skipped `node_modules`-class directories). A mention that would only resolve past the ceiling stays plain text; stalling the transcript to prove otherwise is worse.

## Never-Rules

- **Kernel realms**: `runInRealm()` spawns per-task `DedicatedWorker`; SIGKILL → exit 137. Sync `readFileSync`/`writeFileSync` and
  `child_process.execSync`/`execFileSync`/`spawnSync` from realm scripts go through
  `realm/sync-{xhr,fs-*,exec-*}.ts` + `ui/sync-fs-sw-handler.ts` with per-realm
  capability tokens; never bypass. On an isolated leader the same dispatchers are
  reached over `realm/sync-sab-*.ts` (Atomics/SharedArrayBuffer on the realm's
  own port) — only for `Realm.isolatedThread` realms; the in-process factory must
  never get a SAB (self-deadlock). Deep reference: `docs/kernel/process-model.md`.
- **Scoop queue**: pure-lick batches defer while `ScoopContext.isBusy` without
  queue/watermark loss; user `web` bypasses the window (immediate/awaited,
  prevents deferral). `transcript-limits.ts` caps bridge/event transcripts at 64 KB
  — never the canonical `agent-sessions` history or compaction input.
- **Agent bridge defaults** (`agent-bridge.ts`): writable
  `[cwd, /shared/, <scratch>/, /tmp/]`, visible `[/workspace/, invokingCwd]`;
  `--read-only` replaces them.
- **Mount signing is browser-naive**: CLI → `/api/s3-sign-and-forward`,
  extension → SW. Never sign in the browser. See `docs/mounts.md`.
- **Shell/mount cache**: `script-catalog.ts` caches per `$PATH` root set;
  the `FsWatcher` cache is bypassed only for root sets a mount overlaps
  (external changes there are invisible). `.jsh` lookup follows `$PATH` —
  never reintroduce a full-VFS scan (#2085).
- **`typescript` v7 has no browser/WASM API** — use `typescript-js` (v6) for browser
  `tsc`/`test`/`esm-transpile`. `builtin-shadow-map.ts` is authoritative for
  `ipx`/`npx` → built-in redirects.
- **`esbuild.initialize` needs `worker: false` + a bounded wait** in every browser
  float: with `worker: true` it settles only on a nested `blob:` Worker's first
  message (no `onerror`, no timeout), so a blocked blob worker hangs forever
  (#2200). Never cache a load promise that can stay pending — `esbuild-wasm.ts`
  records a stall instead. See `docs/pitfalls.md`.
- **Speech is page-realm only** (mic, AudioContext); kernel worker bridges via
  `hear-*` panel-RPC. Extension `uiOnly` side panel: Chrome denies `getUserMedia`
  from a cross-origin iframe, so `wc-follower.ts` skips `ptt` and drops
  "Take a photo".
- **Cherry origin detection** (`cherry-host-transport.ts`): `resolveParentOrigin()`
  prefers `location.ancestorOrigins[0]` (unforgeable); `document.referrer` alone
  breaks when Referer is stripped or in HTTP-in-HTTPS dev embeds.
- **Cherry envelope gate** (`cherry-host-protocol.ts`): three factors — origin
  allowlist + `MessageEvent.source` identity + per-mount `channelId` nonce.
  `packages/cherry/src/protocol.ts` is a structural mirror; keep in sync.
- **Sudo self-protection**: writes to `/etc/sudoers` + `/etc/sudoers.d/*` always
  require approval, hardcoded in `matchPath`. Deep reference: `docs/approvals.md`.
- **"Agent can't self-approve" does NOT cover page-realm code** (which can reassign
  `globalThis.confirm`): `sudo/panel-responder.ts` captures natives at module
  init; approval chrome mounts via `ui/wc/trusted-layer.ts`, never `document.body`.
  The panel terminal is intentionally NOT gated.
- **Sudo brokers** are float-specific (`createSudoBroker`): extension-delegate
  relays via hosted leader tab; standalone/Electron POSTs `/api/sudo-approve`.
  All of them are wrapped in `withApprovalTimeout` — an unanswered prompt
  settles after 5 min as `{ decision: 'deny', reason: 'user-timeout' }` (the
  scoop → cone leg uses `cone-timeout`; different approver, different recovery)
  so the blocked turn is released. `reason` is a FIELD, never a fourth
  `decision` value: every gate branches on `deny`, so a new variant would fail
  open. The wrapper also aborts `SudoRequestOptions.signal` before resolving, so
  a broker whose `suggest` outlived the budget cannot raise a stale prompt.
- **Frozen-session recovery** must go through the **bounded** legacy enrichment
  call — never the unbounded curator (`timeoutSeconds` cannot stop it). Save /
  Skip memory / Erase clear cone chat and non-mount `/tmp`, not scoops.
- **Layouts** (`docs/layouts.md`): behind `panel-layouts` flag. `panelize-shell.ts`
  RE-PARENTS what `mountWcShell` built, so `WcShellRefs` stays valid.
  `setPanelVisible` must add an unplaced panel but never duplicate a placed one;
  `sanitizeLayoutName` guards the path a name becomes.
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts`
  removes only providers tracked in `localStorage['slicc_cloud_managed']` — never
  user-added ones. `?connect=1` is login-only (`ui/connect-surface.ts`), no kernel.
- **Never monkeypatch a method on a get/set-asymmetric Proxy.** The sudo-fs Proxy
  advertises `MONKEYPATCH_UNSAFE_FS` (a `Symbol.for` marker);
  `getCompatibilitySkillCandidates` skips hooks and cache for it. Reassigning a
  gated method creates an `override↔wrapper` async recursion that OOMs the kernel
  worker.
- **Adobe `X-Session-Id` invariant**: every LLM call to the Adobe proxy must attach
  the `X-Session-Id` header. `scoop-context.ts` wires it for the agent `streamFn`
  and compaction `headers`; new call sites (`streamSimple`/`completeSimple`,
  pi-coding-agent helpers) must attach it explicitly.
  `providers/adobe.ts`'s `ensureSessionIdHeader` is defense-in-depth
  (daily-rotated sentinel UUID + warning), not the fix location. See
  `docs/pitfalls.md`.
- **Claude Bedrock capability shims** (temperature rejected by Opus ≥ 4.7;
  adaptive thinking for Opus/Sonnet ≥ 4.6): fix at the provider layer via
  `src/providers/claude-model-version.ts` (`parseClaudeVersion` + predicate
  helpers), never at the call site. See `docs/pitfalls.md`.

## Key Conventions

- **Two type systems**: legacy `tools/` + pi-compatible `core/`; bridge via
  `tool-adapter.ts`.
- **Logging**: `createLogger('namespace')` (`base/logger.ts`).
- **Extension detection**: `isExtensionRealm()` from `base/runtime-env.ts`.
- **Tool-output images**: `<img:data:…>` markers are parsed in exactly one place
  (`base/image-markers.ts`) so every consumer agrees on what is an image — the
  bash tool exempts markers from its 40KB cap, `core/tool-adapter.ts` turns them
  into image content blocks, `scoops/transcript-limits.ts` strips them, and
  `ui/wc/wc-message-view.ts` renders them inline. Marker-shaped prose and
  markers sliced mid-payload stay inert text everywhere.
- **Dual-mode compatibility**: features must work in both standalone/CLI and
  extension. The thin extension runs no dynamic code itself — realms, WASM, and
  sprinkles/dips run in the hosted leader tab / kernel worker.
- **Agent-avatar expressions** (`ui/wc/wc-live-callbacks.ts`,
  `wc-live-composer.ts`, `wc-live-controller.ts`): the face's activity comes from
  the descriptors (`toSwitcherScoops` → `awaiting` for the scoop whose turn just
  ended, cleared on submit or any non-`ready` status). Transients are host calls
  on `refs.switcher`: `scrutinize()` + `wake()` per composer `input`, `glower()`
  on a `tool_result` with `isError`. Channels:
  `docs/webcomponents-details.md`.
- **Model IDs**: pi-ai aliases such as `claude-opus-4-6`, not dated snapshots.
- **Provider composition**: pi-ai auto-discovered + `src/providers/built-in/` +
  `providers/`; merge order pi-ai → `modelOverrides` → `getModelIds()`. Build
  filtering: `packages/dev-tools/providers.build.json`.

## VFS API Patterns

- Prefer absolute VFS paths: `/workspace/...` and `/shared/...`.
- `VirtualFS.create({ dbName, wipe })` is the entry point for isolated testable
  instances.
- Mounted directories bridge directly to `FileSystemDirectoryHandle`; do not copy
  large trees into IndexedDB unless you mean to.
- Use `fs.walk()` and `path-utils.ts` helpers instead of ad hoc path splitting.
- `RestrictedFS` is the correct boundary when code should not see the whole VFS.

## Related Guides

- [`docs/webapp-details.md`](../../docs/webapp-details.md) — full subsystem detail
- `packages/chrome-extension/CLAUDE.md`, `packages/node-server/CLAUDE.md` — float guides
- `docs/architecture.md`, `docs/shell-reference.md`, `docs/mounts.md`, `docs/secrets.md`
- `docs/kernel/process-model.md`, `docs/transcript-export.md`, `docs/approvals.md`
- `docs/layouts.md`, `docs/pitfalls.md`
