# Approvals — capability gates

SLICC mediates every sensitive agent action through a **capability approval gate**: the
agent can _request_ the action, but the decision is always resolved by a real human
gesture or an OS-level dialog. The agent can never fabricate the answer.

Three families of gates share that invariant:

1. **Sudo** — SLICC's own `/etc/sudoers` policy over filesystem reads/writes and shell
   commands.
2. **Device & gesture gates** — Chromium-owned permission UI for the File System Access
   directory picker (`mount`) and the WebUSB / WebHID / Web Serial pickers
   (`usb`/`serial`/`hid`/`esptool`).
3. **OS capture gates** — operating-system-owned permission dialogs for screen sharing
   (`screencapture`) and microphone capture (voice input).

Each subsequent section is the **single authoritative description** for one family;
other developer docs link here instead of restating the model.

## Authority axis

| Authority               | Gates                                                                       | Resolved by                                                                                                         | Bypassable by agent?         |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **SLICC**               | Sudo `Read` / `Write` / `Cmnd` rules in `/etc/sudoers` + `/etc/sudoers.d/*` | `window.confirm` (extension panel) or native OS dialog via `POST /api/sudo-approve` (CLI / Electron / swift-server) | No — fail-closed             |
| **Browser** (Chromium)  | File System Access picker (`mount`), WebUSB / Web Serial / WebHID `request` | Chromium's own permission UI; only fires from a real user-gesture handler                                           | No — no gesture, no API call |
| **OS** (macOS TCC etc.) | Screen recording, microphone, camera                                        | macOS TCC / Windows / Linux equivalent dialogs                                                                      | No — the OS owns the verdict |

## Threat model

- **Agent cannot self-approve.** Brokers fail closed: any transport error, malformed
  response, or missing gesture resolves to `deny`. The same holds for the gesture-
  bridged pickers — without a real keystroke the browser never opens them.
- **Panel terminal is the human approver.** Commands typed in the panel terminal are
  not sudo-gated and the keystroke itself is the gesture for browser pickers; this
  is the only context where the human is _already_ approving.
- **Self-protection is hardcoded.** Writes to `/etc/sudoers` and `/etc/sudoers.d/**`
  always require approval; no `NOPASSWD` rule can override this.
- **Credentials never reach the agent.** S3 / DA mounts have no approval card because
  the trust boundary lives at the credential resolver (node-server / SW), not in chat.

---

## Sudo — `/etc/sudoers` policy

SLICC can require a genuine human approval before the agent runs a sensitive action.
Approvals are driven by a sudoers-style policy at `/etc/sudoers` (plus `/etc/sudoers.d/*`
drop-ins) and enforced at two layers: the agent filesystem and the shell command
dispatch.

### What gets gated

| Layer             | Where                                   | Matches              |
| ----------------- | --------------------------------------- | -------------------- |
| Filesystem reads  | `read_file` tool + shell file reads     | `Read <glob>` rules  |
| Filesystem writes | `write_file`/`edit_file` + shell writes | `Write <glob>` rules |
| Commands          | each top-level segment of a `bash` line | `Cmnd <glob>` rules  |

The agent's FS handle is wrapped once with `createSudoFs`, and that single gated
handle backs both the file tools and the shell, so a `cat`/`echo >` in bash is
gated by the same `Read`/`Write` rules as the file tools. Denied commands exit
`1` with `sudo: approval denied`; denied file ops throw `EACCES`.

The **panel terminal is not gated** — the human typing there is already the approver.

### `/etc/sudoers` format

One rule per line. Comments (`#`) and blank lines are ignored.

```text
Cmnd  git push*                 # prompt before any matching command segment
Read  /shared/secrets/**        # prompt before reading a matching VFS path
Write /workspace/.git/**        # prompt before writing a matching VFS path
NOPASSWD Cmnd  git push origin* # explicit grant: matching action runs, no prompt
```

Globs:

- **Command globs** — `*`/`**` match any run of characters, `?` matches one.
- **Path globs** — `*` matches within one path segment (no `/`), `**` matches
  across segments; a trailing `/**` also matches the directory itself.

Precedence: a matching `NOPASSWD` grant wins (no prompt); otherwise any plain
match requires approval; no match is never gated.

A fully commented-out default template ships on a fresh VFS
(`packages/vfs-root/etc/sudoers`), so out of the box nothing extra prompts.

### Self-protection (always on)

Writes to `/etc/sudoers` and anything under `/etc/sudoers.d/` **always** require
approval — a `NOPASSWD` rule cannot override this. It is hardcoded in `matchPath`
(`packages/webapp/src/shell/sudo/sudoers.ts`), independent of the loaded policy.
Reads of those files are allowed (visudo-style).

### Live reload

`SudoManager` watches `/etc` via the shared `FsWatcher` and re-reads + re-merges
the policy on any change to `/etc/sudoers` or `/etc/sudoers.d/*`. Because the FS
gate and command guard both call `getPolicy()` per-op, edits take effect
immediately — no restart:

- The agent edits `/etc/sudoers` (with approval) → reload → new rules active.
- The human picks **"Always"** on a prompt → the generalized pattern is appended
  to `/etc/sudoers.d/granted` → reload → no future prompt for that pattern.

Command-level "Always" grants are persisted through the manager's raw-VFS sink
(`getShellConfig().persistCommandGrant`) so the grant write to
`/etc/sudoers.d/granted` does not itself trip self-protection.

### Architecture

```text
Orchestrator.init()
  └─ new SudoManager({ fs: sharedFs, watcher })  // seed + load + watch
       ├─ getBroker()         → createSudoBroker()         // user broker (cone)
       ├─ getPolicy()         → live merged global SudoersPolicy
       ├─ getPolicyForScoop() → global ∪ /scoops/<folder>/etc/sudoers
       └─ getShellConfig()    → { getPolicy, broker, persistCommandGrant }

Orchestrator.createScoopTab(jid)
  ├─ if non-cone: RestrictedFS(..., 'sudo-delegated')   // writes pass through to SudoFS
  ├─ if non-cone: seedScoopSudoers(folder, config) ...  // first boot only
  ├─                              ... or reloadScoopPolicyByFolder()  // existing file
  └─ new ScoopContext(scoop, callbacks, fs, ..., sudoManager)

ScoopContext.init() — non-cone scoop
  ├─ broker     = { requestApproval: req => callbacks.onSudoRequest(req) }  // cone-mediated
  ├─ getPolicy  = () => sudoManager.getPolicyForScoop(folder)
  ├─ default    = 'require-approval'
  ├─ gatedFs    = createSudoFs(fs, { broker, getPolicy, defaultDisposition })
  └─ new AlmostBashShell({ fs: gatedFs, sudo: { ..., defaultDisposition } })

ScoopContext.init() — cone (unchanged)
  ├─ broker     = sudoManager.getBroker()                  // user broker
  ├─ getPolicy  = () => sudoManager.getPolicy()            // global only
  ├─ default    = 'allow'
  ├─ gatedFs    = createSudoFs(fs, { broker, getPolicy, defaultDisposition: 'allow' })
  └─ new AlmostBashShell({ fs: gatedFs, sudo: getShellConfig() })
```

Brokers (`packages/webapp/src/sudo/`):

- **Extension** — `createExtensionSudoBroker` relays offscreen → side panel via
  `chrome.runtime.sendMessage`; the panel responder (`installPanelSudoResponder`,
  wired in `ui/main.ts`) raises the real `window.confirm`/`window.prompt`.
- **CLI / Electron** — `createHttpSudoBroker` POSTs `POST /api/sudo-approve`
  (`packages/node-server/src/sudo/`), which selects an OS-native backend
  (Electron / osascript / PowerShell / zenity / TTY).
- **Native macOS (swift-server)** — when Sliccstart launches the bundled
  `slicc-server`, `createHttpSudoBroker` POSTs the same `POST /api/sudo-approve` to
  `packages/swift-server/Sources/Server/SudoApprove.swift`, which raises the
  identical `osascript` dialog as node-server. Loopback-only (the server binds
  `127.0.0.1`) and fail-closed (`deny`) on any error, non-zero exit, dismissed
  dialog, or unparsable output.

All brokers **fail closed**: any transport error, malformed response, or missing
gesture resolves to `deny`.

### Cone-mediated approval (scoop → cone tools)

When a non-cone scoop hits a sudoers gate, the request does NOT go to the human
directly — it routes through the cone agent. Same goes for the explicit-request
surface: a scoop calls `sudo_request` to ask up-front, and the cone resolves the
request with `sudo_allow` (allow-once or always-and-persist) or `sudo_deny`.

| Tool                 | Side  | Purpose                                                                                                                                                  |
| -------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sudo_request`       | Scoop | Ask the cone for an explicit escalation. Inputs: `kind` (`command`/`read`/`write`/`secret`), `detail`, optional `suggested_pattern`. Blocks on cone.     |
| `sudo_allow`         | Cone  | Approve a pending request by `request_id`. `always=true` additionally appends a `NOPASSWD <directive> <pattern>` line to the requesting scoop's sudoers. |
| `sudo_deny`          | Cone  | Refuse a pending request. The scoop's action does NOT run.                                                                                               |
| `list_sudo_requests` | Cone  | Snapshot outstanding requests (`id`, scoop folder, kind, detail).                                                                                        |

The pending-request registry lives on the `Orchestrator` (`enqueueSudoRequest`,
`resolveSudoRequestAndPersist`, `listPendingSudoRequests`). The scoop's gated
FS/shell sees a regular `SudoBroker` built by `createConeApprovalBroker` whose
`requestApproval` enqueues into the same registry as the explicit tool. Both
paths resolve fail-closed (`deny`) on transport error, scoop drop, orchestrator
shutdown, or the per-request timeout (`CONE_SUDO_TIMEOUT_MS`).

"Always" grants for `kind: 'command' | 'read' | 'write'` are persisted via
`SudoManager.appendScoopRule(folder, kind, pattern)` (raw-VFS write, same trusted
sink that powers `seedScoopSudoers`, so it bypasses the per-scoop self-protection
on `/scoops/<folder>/etc/sudoers`). `kind: 'secret'` cannot be persisted because
there is no matching sudoers directive — the cone tool surfaces this as
"approved but not persisted" so the agent retries the request next time.

#### Unified enforcement (sudo is the single surface)

The per-scoop sudo policy is the **single enforcement surface** for non-cone
scoops. The other historical gates — the `RestrictedFS` write-EACCES and the
shell `allowedCommands` registration filter — defer to sudo so out-of-sandbox
actions escalate to the cone instead of dying with a hard wall:

- **Filesystem writes.** `RestrictedFS` is constructed with
  `writeEnforcement: 'sudo-delegated'` for non-cone scoops. A write to a path
  outside the scoop's `writablePaths` no longer throws `EACCES` here; it
  passes through to the outer `SudoFS`, whose `defaultDisposition:
'require-approval'` upgrades the unmatched `no-match` to an escalation. The
  per-scoop sudoers file (seeded from `ScoopConfig.writablePaths` as
  `NOPASSWD Write <p>/**` rules) keeps in-sandbox writes prompt-free.
  - **Reads stay silently filtered.** `SudoFS` only applies the
    `'require-approval'` default to **writes** — `RestrictedFS` keeps
    returning `ENOENT`/`[]` for out-of-sandbox reads. This is intentional:
    a scoop's PATH resolution and skill discovery probe many paths that
    don't exist, and escalating each would flood the cone with approval
    requests for innocent lookups.
  - **Symlink escape stays hardcoded.** A `/scoops/<f>/escape-link →
/etc/sudoers` style escape is still rejected with `EACCES` inside
    `RestrictedFS` regardless of mode — sudo gates the literal path the
    agent passed (which is in-sandbox), not the resolved target, so the
    symlink-realpath check is a security invariant, not a policy choice.
- **Shell commands.** When `ShellSudoConfig.defaultDisposition` is
  `'require-approval'`, `AlmostBashShell` skips the `allowedCommands`
  registration filter entirely and registers every built-in. The
  per-scoop sudoers file (`NOPASSWD Cmnd <c>*` per `allowedCommands` entry)
  decides at dispatch which commands run unprompted; unmatched commands
  escalate to the cone. Without this, an unmatched command would surface
  as "command not found" — a hard block the agent cannot recover from.

The cone is unchanged: its `defaultDisposition` is `'allow'`, so only
explicit `/etc/sudoers` rules gate cone actions. The cone's shell still
sees its user broker, and the cone's `RestrictedFS` is not used at all
(the cone runs against the raw `sharedFs`).

`sudo_request` and `list_sudo_requests` are listed in
`packages/webapp/src/scoops/hidden-tools.ts` so the plumbing tool-call rows do
not spam the chat UI; the user-visible event is the `[sudo-request]` channel
message the orchestrator delivers to the cone, and the user-visible decision is
the `sudo_allow` / `sudo_deny` tool call.

### Explicit `sudo <cmd>` shell command

The transparent `Cmnd` gate above prompts whenever the agent runs a command that
matches a policy rule. The `sudo` supplemental command
(`packages/webapp/src/shell/supplemental-commands/sudo-command.ts`) is the
**explicit** elevation surface for the agent — `sudo <cmd> [args...]` routes a
sensitive action through the broker on demand, even when no policy rule would
have fired. Wiring mirrors the transparent gate: same `SudoBroker`, same
"Allow" / "Always" / "Deny" verdict, same `/etc/sudoers.d/granted` sink on
"Always".

Behavior:

- The inner `args` are forwarded verbatim to `ctx.exec` (no shell re-parsing), so
  arguments containing spaces or glob characters survive intact — matching the
  bash-builtin `sudo` semantics.
- **Single-prompt invariant**: before dispatching the inner command, `sudo`
  registers a one-shot bypass keyed by canonical subject
  (`name + ' ' + args.join(' ')`) so the transparent `Cmnd` gate does not fire a
  second prompt for the same invocation. A nested inner command that itself
  runs a separately-gated subject still prompts once on its own.
- **Deny** exits `1` with `sudo: approval denied`; the inner command does not
  run.
- **Always** persists the broker-supplied pattern (defaulting to the canonical
  subject) via the same `persistCommandGrant` sink the transparent gate uses, so
  the `NOPASSWD Cmnd` line appears in `/etc/sudoers.d/granted` and live-reload
  picks it up immediately.
- **No broker configured** (e.g. panel terminal — already the approver) exits
  `1` with `sudo: command-level approval is not configured`.

### Files

| Path                                                              | Role                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/webapp/src/shell/sudo/sudoers.ts`                       | Parser + matcher + self-protection                                       |
| `packages/webapp/src/sudo/sudo-manager.ts`                        | Live policy store + reload + broker                                      |
| `packages/webapp/src/fs/sudo-fs.ts`                               | FS-level gate (`createSudoFs`)                                           |
| `packages/webapp/src/shell/sudo/command-guard.ts`                 | Command-level gate                                                       |
| `packages/webapp/src/shell/supplemental-commands/sudo-command.ts` | `sudo <cmd>` explicit-request surface                                    |
| `packages/webapp/src/sudo/*-broker.ts`                            | Float-specific approval brokers                                          |
| `packages/webapp/src/sudo/cone-broker.ts`                         | Cone-mediated broker + pending-request registry                          |
| `packages/webapp/src/scoops/scoop-management-tools.ts`            | `sudo_request` / `sudo_allow` / `sudo_deny` / `list_sudo_requests` tools |
| `packages/node-server/src/sudo/`                                  | `/api/sudo-approve` + OS dialogs                                         |
| `packages/vfs-root/etc/sudoers`                                   | Default commented-out template                                           |

---

## Device & gesture gates

Browser device-access APIs — `showDirectoryPicker` and the WebUSB / Web Serial /
WebHID `requestDevice` family — only run from inside a real user-gesture
handler. The kernel worker that hosts shell commands has no `window`, so these
APIs cannot run there directly. The panel terminal bridges the gesture; agent
`bash` calls fall back to an in-chat approval dip (`mount`) or fail with a
clear "needs a real user gesture" message (`usb`/`serial`/`hid`/`esptool`).

### Local mount picker

Only **local** mounts surface an approval card. The card is _not_ a consent
gate — it's the click that satisfies Chromium's user-gesture rule for
`showDirectoryPicker`. **S3** and **DA** mounts have no approval card; their
trust boundary is the credential profile resolver (node-server
`/api/s3-sign-and-forward` / `/api/da-sign-and-forward`, or the SW signing
path in extension mode), not chat.

Two gesture paths:

- **Panel terminal** — `RemoteTerminalView`
  (`packages/webapp/src/kernel/remote-terminal-view.ts`) pre-intercepts a typed
  `mount /<path>` line on the Enter keystroke, runs `showDirectoryPicker` in the
  page realm while the gesture is still live, stashes the handle in IDB, and
  forwards a rewritten command so the worker-side `mountLocal` adopts the
  already-granted handle.
- **Agent-driven** — the `mount` shell command (run via `bash`) renders a Tool
  UI approval card in chat (`packages/webapp/src/tools/tool-ui.ts`). The
  user's click is the gesture; the click handler then calls the picker.

In the **extension**, the picker additionally routes through a popup window
(`packages/chrome-extension/mount-popup.html` + shared helpers
`openMountPickerPopup` / `loadAndClearPendingHandle` / `reactivateHandle` in
`packages/webapp/src/fs/mount-picker-popup.ts`). Chrome's side panel cannot
host macOS TCC (Transparency, Consent, and Control) permission dialogs and
crashes when `showDirectoryPicker` is invoked there against a system folder
Chrome refuses to share (Documents/Downloads/Desktop/home). All three
extension-side mount entry points use the popup: the shell `mount` command,
agent-driven approval dips, and the welcome sprinkle's `request-mount` lick.

Local mounts are cone-only because the directory picker requires a real user
gesture. S3 / DA mounts are allowed from scoops since their credentials come
from the secret store.

### `usb` / `serial` / `hid` / `esptool`

`usb request`, `serial request`, `hid request`, and `esptool` without `--port`
all call a WebUSB / Web Serial / WebHID device picker. Same gesture constraint
as `mount`.

The panel terminal bridges the gesture identically: `RemoteTerminalView`
pre-intercepts a `<cmd> request` line on Enter, runs the picker in the page
realm, then forwards a rewritten command carrying `--__resolved <handle>` so
the worker-side command body looks up the already-granted device instead of
prompting. In the extension, the picker additionally routes through a
dedicated popup window (`usb-picker-popup.html` / `serial-picker-popup.html` /
`hid-picker-popup.html`) because the side panel cannot host `requestDevice`
reliably.

Because the gesture must originate from a real keystroke, the picker
subcommands do **not** work from an agent `bash` tool call or a scoop with no
UI — only from the panel terminal (cone) or an extension popup. Already-
granted handles (from `*-list`/`*-request`) can be operated on from any realm
via panel-RPC. Chromium-only; unavailable in the cloud / hosted-leader float.

### Authoring agent-driven approval UI

`packages/webapp/src/tools/tool-ui.ts` exposes the shared "show HTML, await
user click" primitive that agent-driven commands use to acquire a gesture in
chat. See [`docs/adding-features.md` §14](./adding-features.md#14-add-interactive-tool-ui-approval-dialogs-forms)
for the API and HTML conventions.

### Files

| Path                                                           | Role                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/webapp/src/kernel/remote-terminal-view.ts`           | Keystroke gesture pre-intercept (`mount`, `*-request`) |
| `packages/webapp/src/fs/mount-picker-popup.ts`                 | Extension popup helpers for the FS-Access picker       |
| `packages/chrome-extension/mount-popup.html`                   | Extension mount picker popup shell                     |
| `packages/chrome-extension/{usb,serial,hid}-picker-popup.html` | Extension device picker popups                         |
| `packages/webapp/src/tools/tool-ui.ts`                         | Agent-driven approval-card primitive                   |

---

## OS capture gates

Screen sharing and microphone capture are decided by the operating system, not
by SLICC or the browser policy. Approval semantics are owned by the OS dialog;
SLICC's only job is to invoke the API from a context where the dialog can
appear.

### `screencapture` — screen sharing

`screencapture` (`packages/webapp/src/shell/supplemental-commands/screencapture-command.ts`)
calls `navigator.mediaDevices.getDisplayMedia()`. The browser raises a picker
listing windows/screens; on macOS the first invocation also triggers a TCC
prompt for screen recording. The command must run from a context that can host
the dialog — same constraint as the mount picker.

### Microphone (voice input)

`packages/webapp/src/ui/voice-input.ts` calls
`navigator.mediaDevices.getUserMedia({ audio: true })`. Chrome's side panel
cannot trigger the mic permission prompt — `getUserMedia` silently fails. The
voice-input module falls back to a popup window (`voice-popup.html`) for the
one-time permission grant; once granted, permission is cached per origin and
subsequent invocations succeed directly in the side panel. The mechanics are
documented in [`docs/pitfalls.md` "Voice Input: Extension Workaround"](./pitfalls.md#voice-input-extension-workaround).

### Files

| Path                                                                       | Role                                      |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/webapp/src/shell/supplemental-commands/screencapture-command.ts` | `getDisplayMedia` invocation              |
| `packages/webapp/src/ui/voice-input.ts`                                    | `getUserMedia` + extension popup fallback |
| `packages/chrome-extension/voice-popup.html`                               | Extension mic-permission popup shell      |
