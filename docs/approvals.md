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
- **Self-protection is hardcoded.** Writes to `/etc/sudoers`, `/etc/sudoers.d/**`
  and `/etc/APPROVALS.md` always require approval; no `NOPASSWD` rule can override
  this.
- **Credentials never reach the agent.** S3 / DA mounts have no approval card because
  the trust boundary lives at the credential resolver (node-server / SW), not in chat.

---

## Sudo — `/etc/sudoers` policy

SLICC can require a genuine human approval before the agent runs a sensitive action.
Approvals are driven by a sudoers-style policy at `/etc/sudoers` (plus `/etc/sudoers.d/*`
drop-ins) and enforced at two layers: the agent filesystem and the shell command
dispatch.

### What gets gated

| Layer             | Where                                       | Matches               |
| ----------------- | ------------------------------------------- | --------------------- |
| Filesystem reads  | `read_file` tool + shell file reads         | `Read <glob>` rules   |
| Filesystem writes | `write_file`/`edit_file` + shell writes     | `Write <glob>` rules  |
| Commands          | each top-level segment of a `bash` line     | `Cmnd <glob>` rules   |
| Transcript export | a follower's / Cherry host's export request | `Export <glob>` rules |

`Export` is the odd one out: an export is **always** gated (there is no "no match
means ungated"), so a `NOPASSWD Export <glob>` grant is the only way to skip its
prompt. The subject is `active` for the live session or `frozen:<sessionId>` for
an archive. Issue #2062 folded this gate into sudo — it used to be its own
`transcript.export.approve.*` dialog pair.

The agent's FS handle is wrapped once with `createSudoFs`, and that single gated
handle backs both the file tools and the shell, so a `cat`/`echo >` in bash is
gated by the same `Read`/`Write` rules as the file tools. Denied commands exit
`1` with `sudo: approval denied`; denied file ops throw `EACCES`. A prompt that
goes unanswered for five minutes blocks the same way but reports a _timeout_
instead — see [Approval timeout](#approval-timeout).

The **panel terminal is not gated** — the human typing there is already the approver.

### `/etc/sudoers` format

One rule per line. Comments (`#`) and blank lines are ignored.

```text
Cmnd  git push*                 # prompt before any matching command segment
Read  /shared/secrets/**        # prompt before reading a matching VFS path
Write /workspace/.git/**        # prompt before writing a matching VFS path
NOPASSWD Cmnd  git push origin* # explicit grant: matching action runs, no prompt
NOPASSWD Export active          # let followers export the live transcript unprompted
```

Globs:

- **Command globs** — `*`/`**` match any run of characters, `?` matches one.
- **Path globs** — `*` matches within one path segment (no `/`), `**` matches
  across segments; a trailing `/**` also matches the directory itself.

Precedence: a matching `NOPASSWD` grant wins (no prompt); otherwise any plain
match requires approval; no match is never gated.

A default template ships on a fresh VFS (`packages/vfs-root/etc/sudoers`). Every
example rule in it is commented out; the one **active** rule is `Write /etc/models`
— see [Model access policy](#model-access-policy----etcmodels) for why that file
in particular is gated. Nothing else prompts out of the box.

The template is only ever written to a _fresh_ filesystem, so an existing profile
keeps its own `/etc/sudoers`. Rule changes reach it through `upgrade apply` (the
upgrade lick's card), which three-way-merges `packages/vfs-root/etc/` — see the
[upgrade skill](../packages/vfs-root/workspace/skills/upgrade/SKILL.md). Applying
such a merge still raises an approval prompt of its own, because the shell runs on
the FS-gated handle and `/etc/sudoers` is self-protected: the card authorizes the
merge, the prompt authorizes the policy edit. A user who dismisses the card keeps
their current policy.

### Self-protection (always on)

Writes to `/etc/sudoers`, anything under `/etc/sudoers.d/`, and
`/etc/APPROVALS.md` (the approver agent's instructions — it decides what a
biscotto GUEST may do, so a cone acting on that guest's message must not be able
to rewrite it) **always** require approval — a `NOPASSWD` rule cannot override
this. It is hardcoded in `matchPath` (`packages/webapp/src/base/sudoers.ts`),
independent of the loaded policy. Reads of those files are allowed
(visudo-style).

Both bundled defaults are seeded by `SudoManager.ensureDefaults()` on every boot
when the file is absent, through the manager's **ungated** handle. Shipping a
default is not a policy edit, and an absent file holds no owner decision to
protect. Seeding is also what keeps the upgrade merge quiet: `upgrade apply`
runs on the FS-gated handle, so a self-protected path it had to _create_ would
prompt the owner to approve content identical to the default already in force —
an approval with no diff to show (#2686). With the file seeded, the merge
classifies it `unchanged` (or `kept-local` after an owner edit) and writes
nothing.

### Built-in scoop grants — `/tmp` (always on)

Every non-cone scoop carries an unconditional `NOPASSWD Read` + `NOPASSWD Write`
grant on `/tmp` and `/tmp/**`, on top of whatever its own sudoers file says.
`/tmp` is global scratch space in SLICC the same way it is on Unix: tooling
hardcodes `/tmp/<file>` rather than discovering a scratch dir, and without the
grant every such write escalated to the cone for approval.

The space is **shared, not per-scoop** — scoops can read and clobber each
other's scratch files, and the cone sees all of them. Nothing secret or
trust-bearing belongs in `/tmp`. A scoop that needs private scratch has
`/scoops/<folder>/tmp`, which `ScoopContext.ensureDirectoryStructure` creates.

Two consequences worth knowing:

- Because a `NOPASSWD` grant beats a plain match, a `Write /tmp/**` rule in
  `/etc/sudoers` **cannot** gate a scoop's `/tmp` writes. The cone's own view
  (`getPolicy()`) still honours it.
- The grant lives in code (`builtinScoopGrants()` in
  `packages/webapp/src/base/sudoers.ts`), merged in by `getPolicyForScoop`, not
  in the per-scoop config grants — those are compiled from each scoop's own
  `ScoopConfig`, while `/tmp` applies to every scoop unconditionally. The
  matching ACL exemption is `ALWAYS_WRITABLE_PREFIXES` in
  `packages/webapp/src/fs/restricted-fs.ts`; `SudoFS` and `RestrictedFS` gate
  independently, so both layers must agree or the write is walled underneath
  the grant.

### Ephemeral shell descriptors — `/dev/fd/<n>` (never gated)

Process substitution (`<(cmd)` / `>(cmd)`) is modelled on a backing file at
`/dev/fd/<n>`, numbered downward from 63 exactly as bash numbers it: the body's
stdout is written there during word expansion, the outer command reads the path
back, and the descriptor is released when that command ends.

Those paths are **never a policy subject**. `matchPath` resolves them to
`nopasswd-allow` for both reads and writes (`isEphemeralFdPath` in
`packages/webapp/src/fs/virtual-device-paths.ts`), before any rule is consulted —
self-protection is still checked first and stays absolute. The reason is that
there is nothing for a prompt to be _about_: the path is minted by the shell for
the duration of one command, the fd number changes every invocation (so no
"Always" grant could ever pre-empt the prompt), and the only reader is the
consuming command in the same pipeline. A sandboxed scoop that hit such a prompt
stalled indefinitely, because only the cone can clear it (#2502).

The matching ACL exemption is the private `EphemeralFdStore` held by each
`RestrictedFS` (`packages/webapp/src/fs/ephemeral-fd-store.ts`). As with `/tmp`,
`SudoFS` and `RestrictedFS` gate independently, so both layers have to agree:
granting only in the policy leaves the consumer's open walled to `ENOENT` while
the write lands _outside_ the sandbox, and exempting only in the ACL leaves the
approval prompt in place.

Unlike `/tmp`, this space is **private per sandbox and never enters the tree**:

- descriptors are not addressable across scoops, commands or turns, and nothing
  is written to `/dev/fd` in the shared VFS;
- `/dev` and `/dev/fd` remain non-existent in a scoop's view — no listing, no
  `stat`, no `readDir` entry;
- a descriptor that was never written raises `ENOENT` on read, the same loud
  failure the cone gives for an unopened fd.

The exemption covers exactly what process substitution needs — a content write,
the read back (including as either end of a `copyFile`, which is how `cp <(…)`
arrives), and the release (`rm`). Every **tree-shape** op on a descriptor path is
refused with `EACCES` by `RestrictedFS.refuseDescriptorTreeOp`: `mkdir`,
`symlink`, `rename` and `mount`/`unmount`/`refreshMount`. That refusal is the
containment for those ops, and it has to live in the ACL layer, because the
policy layer deliberately answers `nopasswd-allow` rather than raising a prompt.
Without it, a `mkdir /dev/fd/63` in a `sudo-delegated` sandbox would fall through
to the shared `VirtualFS` and create exactly the cone-visible, cross-scoop
`/dev/fd` entry the private store exists to prevent.

This is not a widening of the sandbox: a scoop can already express the same data
flow with a temp file under `/tmp`, which is unconditionally writable, so gating
`<(...)` bought no containment — it only broke the ergonomic spelling. It is
also deliberately **not** modelled as a no-op device write like `/dev/null`: a
descriptor's payload is read back, so discarding it would turn `cat <(echo hi)`
from an error into silently empty output.

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

## Model access policy — `/etc/models`

`agent --model` and `scoop_scoop` accept a `provider:model` id, so a scoop can be
spawned on a provider OTHER than the selected one (#2195). That moves spend onto a
different account — a work provider rather than a personal one — so which
combinations are permitted is configured in `/etc/models`, keyed by the **selected**
provider:

```ini
[adobe]                      # in force while `adobe` is selected
openrouter:*                 # any openrouter model may be targeted
anthropic:claude-opus-4-6    # …plus exactly this one
-openrouter:openai/o3-pro    # …except this one
-adobe:claude-opus-5         # and not adobe's own Opus 5 either
```

- The selected provider's **own** catalogue is always allowed — never list it —
  until a `-` entry subtracts a model.
- Every **other** provider's model needs an explicit allow entry. No file, or no
  section for the selected provider, means own-models-only. A rejection quotes the
  exact line to add.
- A deny beats an allow, in any order. `provider:*` covers a whole catalogue.

Two surfaces read it, deliberately differently:

| Surface                                           | Applies                   |
| ------------------------------------------------- | ------------------------- |
| Spawn resolution (`agent --model`, `scoop_scoop`) | the whole policy          |
| Model picker + `models` command                   | only explicit `-` denials |

Applying the allow-list to the picker would hide every other account's models and
leave the user unable to switch providers at all. Switching your own account is the
user's call; spawning against another account behind their back is what is gated.

`ModelPolicyFile` (scoops layer) seeds the template, parses the file and publishes
the snapshot the synchronous resolvers read; it watches `/etc` for live reload, and
fails **closed** — an unreadable or deleted policy falls back to own-models-only
rather than keeping the last parse. Writes are gated by the shipped `Write
/etc/models` sudoers rule: an agent that could rewrite this file could authorize its
own spend. Reads stay ungated so the agent can explain a refusal.

### Architecture

#### Where the prompt goes (sudo over tray, #2062)

The kernel worker owns the policy (`SudoManager`) and asks a **broker** for the
human gesture. Since #2062 the broker is tray-aware: before the float's native
dialog fires, the page realm (`sudo/page-approval-service.ts`, reached over the
`sudo-request` panel-RPC op) decides who the right approver is —

1. **A tray follower's human** — when the leader is headless (hosted/cloud
   float) or the last user message came from a follower and a follower
   advertised `capabilities.sudoApproval`. `LeaderSyncManager.delegateSudoApproval`
   broadcasts `sudo.approve.request`; first verdict wins, the rest get
   `sudo.approve.cancel`; 5-minute fail-closed timeout. iOS answers behind
   Face ID / passcode and is the only kind of follower whose `always` is
   honoured (`capabilities.biometric`); a web follower's `always` is downgraded
   to a one-shot allow. A headless leader with nobody connected parks the
   prompt and asks the hub to push-wake registered phones.
2. **The native dialog** — node-server OS dialog (CLI/Electron), extension
   panel `confirm`, or panel-RPC to the page for the thin-bridge leader.
3. **The in-page `<slicc-dialog>`** — for a leader tab with a human but no
   node-server (the hosted leader viewed directly in a browser).

Follower-originated gates (transcript export) enter the same funnel from the
page: `LeaderSyncManager` → `request-sudo-approval` kernel message →
`SudoManager.approve()` (policy check, broker, `NOPASSWD Export` persistence)
→ back to the page's broker chain. One policy, one persistence path, one
audit surface.

**Push** — the tray hub DO stores the iOS follower's APNs token (`push.register`,
forwarded by the leader, never persisted by it) and fans out `push.send` for
`turn_end` (normal banner) and `sudo_request` (time-sensitive banner with
Deny / Review… actions; Allow is deliberately not a lock-screen action).
Payloads are metadata only. Secrets: `APNS_TEAM_ID`, `APNS_KEY_ID`,
`APNS_PRIVATE_KEY`, `APNS_TOPIC` on the worker — missing means pushing is off
and nothing else changes.

```text
Orchestrator.init()
  └─ new SudoManager({ fs: sharedFs, watcher })  // seed + load + watch
       ├─ getBroker()         → createSudoBroker()         // user broker (cone)
       ├─ getPolicy()         → live merged global SudoersPolicy
       ├─ getPolicyForScoop() → builtin /tmp grants ∪ global ∪ config grants ∪ /scoops/<folder>/etc/sudoers
       └─ getShellConfig()    → { getPolicy, broker, persistCommandGrant }

Orchestrator.createScoopTab(jid)
  ├─ if non-cone: RestrictedFS(..., 'sudo-delegated')   // writes pass through to SudoFS
  ├─ if non-cone: initScoopPolicy(folder, config)  // config grants registered in memory (#2416)
  │                                                // + load the on-disk Always-grants file
  │                                                //   (legacy generated files are discarded)
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

- **Extension** — the thin extension delegates approval to the hosted leader tab.
  The kernel worker raises the prompt directly in the leader tab (the page realm
  hosts `window.confirm` / `window.prompt`); there is no longer an offscreen-to-
  side-panel relay because the extension does not ship either surface.
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

#### Approval timeout

A sudo prompt blocks the requesting agent turn: until the human answers, the cone
sits on an unresolved `requestApproval` promise and cannot make progress. When
nobody is at the machine that wait is unbounded — the dialog stays up and the
turn hangs indefinitely.

`createSudoBroker` therefore wraps whichever float broker it selects in
`withApprovalTimeout` (`packages/webapp/src/sudo/approval-timeout.ts`). After
`USER_SUDO_TIMEOUT_MS` (5 minutes) the request settles fail-closed as
`{ decision: 'deny', reason: 'user-timeout' }`. That matches
`CONE_SUDO_TIMEOUT_MS`, so both hops of a delegated scoop → cone → user approval
expire on the same budget.

`reason` is a **field on the decision, not a fourth `decision` value**. Every
enforcement layer branches on `decision === 'deny'`, so a new variant would fail
_open_; the field keeps the fail-closed default and only enriches the message.

**Two legs, two notices.** The approver differs per leg, so the recovery advice
must too — telling a scoop to wait for a human who was never prompted is wrong:

| `reason`       | Which leg expired | What the agent is told                                     |
| -------------- | ----------------- | ---------------------------------------------------------- |
| `user-timeout` | cone → user       | the user was not there; report it and wait for them        |
| `cone-timeout` | scoop → cone      | the cone never resolved it; no human was prompted, move on |

Every gate renders both through one helper, `sudoRefusalMessage(prefix, decision)`,
so denial and timeout wording can never drift apart:

| Layer                        | Denied                         | Timed out                                     |
| ---------------------------- | ------------------------------ | --------------------------------------------- |
| Command guard / `sudo <cmd>` | `sudo: approval denied`        | `sudo: approval request timed out — …`        |
| `SudoFS`                     | `EACCES sudo: approval denied` | `EACCES sudo: approval request timed out — …` |
| `secret` command             | `secret: approval denied`      | `secret: approval request timed out — …`      |

**Cancellation.** Settling the caller is not enough on its own. Each broker does
pre-prompt work — an LLM `suggest` call for the "Always" pattern, transport setup
— _before_ it raises the native surface. If that work outlives the budget and
then recovers, an un-cancelled broker would pop a brand-new dialog for an action
the agent abandoned minutes ago. So `withApprovalTimeout` aborts an `AbortSignal`
(`SudoRequestOptions.signal`) before it resolves the caller; every broker passes
it to `suggest`, re-checks `signal.aborted` before prompting, and the HTTP broker
also hands it to `fetch` so the in-flight POST is cancelled.

Known limitation: a dialog _already on screen_ when the budget expires stays
there — there is no cancel channel to `window.confirm` or an OS dialog. A gesture
that lands after the timeout is logged and discarded, including an "Always" grant
(the enforcement layer that owns the persist sink has already moved on).

#### Scope of the "unforgeable gesture" guarantee

The native modal cannot be answered by **the agent's realms** (kernel worker,
offscreen document, JS realms) — that is the property the browser-side brokers
rest on. It is _not_ a guarantee against arbitrary code running in the **page /
panel realm itself**: `globalThis.confirm` is a writable property, so page-realm
JS could assign `() => true` and auto-answer every subsequent approval —
including the writes to `/etc/sudoers` that `matchPath` always gates and no
`NOPASSWD` rule can override.

Two things narrow that gap:

- **The CLI / Electron / swift-server path is stronger by construction.** The
  dialog is raised by a separate process (`POST /api/sudo-approve` →
  osascript / PowerShell / zenity / Electron), completely out of reach of page
  JS. Prefer it wherever it exists.
- **The browser path captures the natives at module init.**
  `packages/webapp/src/sudo/panel-responder.ts` binds `confirm` / `prompt` once
  at module evaluation (during boot, before any dynamically registered UI
  component can run) and calls through the captured reference, never the live
  global. A realm with no native modal denies rather than allowing. Regression
  tests: `packages/webapp/tests/sudo/panel-responder-native-capture.test.ts`.

This is defense-in-depth, not a hard boundary — code that runs before the module
loads is still out of scope. As everywhere else in SLICC (see the sandbox note
in `ui/sprinkle-renderer.ts`), **the trust model is the real boundary**; these
measures keep an accidental or opportunistic override from silently defeating
the gate.

### Cone-mediated approval (scoop → cone tools)

When a non-cone scoop hits a sudoers gate, the request does NOT go to the human
directly — it routes through the cone agent. Same goes for the explicit-request
surface: a scoop calls `sudo_request` to ask up-front, and the cone resolves the
request with `lick_confirm` (allow-once or always-and-persist) or `lick_dismiss`.

| Tool                 | Side  | Purpose                                                                                                                                              |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sudo_request`       | Scoop | Ask the cone for an explicit escalation. Inputs: `kind` (`command`/`read`/`write`/`secret`), `detail`, optional `suggested_pattern`. Blocks on cone. |
| `lick_confirm`       | Cone  | Confirm a pending actionable lick by `lick_id`. `always=true` additionally appends a `NOPASSWD <directive> <pattern>` line to the scoop's sudoers.   |
| `lick_dismiss`       | Cone  | Dismiss a pending actionable lick by `lick_id`. The scoop's action does NOT run.                                                                     |
| `list_sudo_requests` | Cone  | Snapshot outstanding requests (`lick id`, scoop folder, kind, detail).                                                                               |

The pending-request registry lives on the `Orchestrator` (`enqueueSudoRequest`,
`resolveSudoRequestAndPersist`, `listPendingSudoRequests`). The scoop's gated
FS/shell sees a regular `SudoBroker` built by `createConeApprovalBroker` whose
`requestApproval` enqueues into the same registry as the explicit tool. Both
paths resolve fail-closed (`deny`) on transport error, scoop drop, orchestrator
shutdown, or the per-request timeout (`CONE_SUDO_TIMEOUT_MS`). Requests are
independent: a pending approval blocks only the gated operation that raised it,
never another scoop's (or the same scoop's other granted) operations. The cone
does review requests serially — it is a single agent processing its message
queue one turn at a time — which is intended: one approver, ordered decisions.
After any per-scoop policy reload (an "Always" grant, a config registration, a
sudoers-file edit), the orchestrator re-evaluates that scoop's pending requests
and auto-resolves as `allow` those the policy now covers with a `NOPASSWD`
grant (`ScoopApprovalRouter.settleGrantedRequests`, #2416), so one "Always"
approval unblocks the scoop's other queued requests for the same subtree
instead of stalling them until each is individually approved. The timeout path
tags its decision `reason: 'cone-timeout'` so the scoop is told its escalation
went unanswered rather than refused — and, unlike the cone → user leg, is not
told to wait for a user who was never prompted.

"Always" grants for `kind: 'command' | 'read' | 'write'` are persisted via
`SudoManager.appendScoopRule(folder, kind, pattern)` (raw-VFS write, same trusted
sink that powers `initScoopPolicy`, so it bypasses the per-scoop self-protection
on `/scoops/<folder>/etc/sudoers`). Since #2416 that file holds ONLY these
approved "Always" grants — the `ScoopConfig` sandbox is registered in memory
and never persisted, so replacing a scoop's config genuinely revokes the old
authority instead of unioning with a stale file (a legacy generated file found
on load is discarded fail-closed; its grants re-prompt once). The append is idempotent — a rule that is
already in the file is never duplicated (#2416) — and it is the ONLY persistence
path for a scoop's grant: the scoop's `SudoFS` gate gets a no-op `onGrant` sink,
so an `always` decision never leaks into the global `/etc/sudoers.d/granted`
drop-in (which would silently widen every other unit's policy). Persisted `Read` globs also widen the live
`RestrictedFS` ACL, and are reapplied from the scoop policy whenever its context
is recreated. Live sudoers reloads replace those dynamic grants, so manually
adding or revoking a rule updates the running scoop too; non-matching sibling
paths remain hidden. `kind: 'secret'` cannot be persisted because there is no
matching sudoers directive — the cone tool surfaces this as "approved but not
persisted" so the agent retries the request next time.

An "always" grant is only as durable as the folder it lands in. One-shot agents
spawned through `AgentBridge` get a random `agent-<adjective>-<flavor>` folder
that is dropped when the run ends, so a grant persisted into
`/scoops/agent-<name>/etc/sudoers` dies with it and the next run starts from
zero under a name the cone has never seen. For a recurring unattended agent such
as the memory curator, that makes escalation a permanent interruption rather
than a one-time cost: configure its `allowedCommands` to cover the work up
front instead of relying on the cone to grant its way out.

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
  `ScoopConfig` sandbox keeps in-sandbox writes prompt-free: its grants
  (`NOPASSWD Write <p>` + `<p>/**` per `writablePaths` entry, regardless of
  trailing-slash spelling) are registered **synchronously in memory**
  (`SudoManager.registerScoopConfig`, #2416) on every context creation, so a
  stale `/scoops/<folder>/etc/sudoers` file — folder reuse across scoop
  generations, a restore with changed config — or a reload race can never
  withhold a configured path and prompt for it. The on-disk file only ADDS
  persisted "Always" grants on top. The built-in `/tmp` grant does the same
  for shared scratch space. Note the grant covers exactly the configured
  roots: a tool family that writes to another absolute root (e.g. a skill
  writing crops to `/.migration/`) still escalates unless that root is listed
  in `writablePaths` — point skills at the scoop scratch dir, `/shared/`, or
  `/tmp/` instead of inventing new VFS roots.
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

`sudo_request`, `list_sudo_requests`, `lick_confirm`, and `lick_dismiss` are all
listed in `packages/webapp/src/scoops/hidden-tools.ts` so the plumbing tool-call
rows do not spam the chat UI; the user-visible event is the `[sudo-request]`
channel message the orchestrator delivers to the cone, and the user-visible
signal of the decision is the card ✓/✗ flip — not a tool-call row.

#### Card result UX

The `[sudo-request]` message renders as a `<slicc-lick-card>` (the
`'sudo-request'` lick channel). The card carries the orchestrator-minted
`lickId` on its `ChatMessage`. While the request is outstanding the card stays
in its default amber `pending` state. When the cone resolves the request, the
orchestrator persists the decision onto the originating message's `lickState`
and the card flips in place — a green check (`confirmed`) for `lick_confirm` or
a red cross (`dismissed`, rendered muted) for `lick_dismiss` — so the resolved
verdict survives reload. The design-time fixture (`?ui-fixture=1`) carries one
sample per state (`pending` / `confirmed` / `dismissed`) for styling.

#### Other actionable licks (beyond sudo)

The same `lick_confirm` / `lick_dismiss` tools and `lickId` registry generalize
to other approval-style licks. The orchestrator mints a `lickId` at emit time,
registers a per-kind resolver, and dispatches by id in `resolveActionableLick`
(falling through to the sudo resolver). Each card flips and persists exactly like
the sudo card — a green check on confirm, a muted red cross on dismiss.

| Lick kind                           | `lick_confirm`                                                                                                                                                  | `lick_dismiss`                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **navigate · upskill**              | Runs `upskill <url> [--branch ..] [--path ..]` (the "already exists" check still guards duplicate installs).                                                    | Drops the install.                            |
| **navigate · handoff**              | Not agent-confirmable — **human-gated**. The approval dip is the authority; the card still flips ✓ on the human's accept.                                       | Card flips ✗ on the human's dismiss.          |
| **session-reload · mount-recovery** | Re-runs the listed `mount …` commands to re-establish dropped mounts.                                                                                           | Leaves the mounts unmounted.                  |
| **session-reload (plain)**          | _Dismiss-only_ — the reload already happened, so there is no confirm.                                                                                           | Acknowledges and clears the notice.           |
| **upgrade**                         | Triggers "Update workspace files" (the upgrade skill's three-way merge, scoped to the stored `from`→`to` tags). "Review changelog" stays a separate agent step. | Clears the notice without touching any files. |

`navigate · handoff` is the deliberate exception: handoffs are untrusted
external input, so the human's approval dip remains the authority gate and the
agent does not self-approve via `lick_confirm` (the card only reflects the
human's choice). `always` / `pattern` are sudo-only inputs and are ignored for
these kinds. See [`docs/tools-reference.md`](./tools-reference.md) for the full
tool inputs/outputs.

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
  run. An unanswered prompt exits `1` too, with the distinct
  `sudo: approval request timed out — …` message (see
  [Approval timeout](#approval-timeout)).
- **Always** persists the broker-supplied pattern (defaulting to the canonical
  subject) via the same `persistCommandGrant` sink the transparent gate uses, so
  the `NOPASSWD Cmnd` line appears in `/etc/sudoers.d/granted` and live-reload
  picks it up immediately.
- **No broker configured** (e.g. panel terminal — already the approver) exits
  `1` with `sudo: command-level approval is not configured`.

### Files

| Path                                                                 | Role                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/webapp/src/base/sudoers.ts`                                | Parser + matcher + self-protection                                            |
| `packages/webapp/src/sudo/sudo-manager.ts`                           | Live policy store + reload + broker                                           |
| `packages/webapp/src/fs/sudo-fs.ts`                                  | FS-level gate (`createSudoFs`)                                                |
| `packages/webapp/src/shell/sudo/command-guard.ts`                    | Command-level gate                                                            |
| `packages/webapp/src/shell/supplemental-commands/sudo-command.ts`    | `sudo <cmd>` explicit-request surface                                         |
| `packages/webapp/src/sudo/*-broker.ts`                               | Float-specific approval brokers                                               |
| `packages/webapp/src/sudo/approval-timeout.ts`                       | 5-minute fail-closed wrap + `reason: 'timeout'` contract                      |
| `packages/webapp/src/sudo/cone-broker.ts`                            | Cone-mediated broker + pending-request registry                               |
| `packages/webapp/src/scoops/scoop-management-tools.ts`               | `sudo_request` / `lick_confirm` / `lick_dismiss` / `list_sudo_requests` tools |
| `packages/node-server/src/sudo/`                                     | `/api/sudo-approve` + OS dialogs                                              |
| `packages/vfs-root/etc/sudoers`                                      | Default template (only `Write /etc/models` active)                            |
| `packages/webapp/src/shell/supplemental-commands/upgrade-command.ts` | Merges bundled `/etc` policy files into an existing profile                   |
| `packages/webapp/src/providers/model-policy.ts`                      | `/etc/models` parser + evaluator + live snapshot                              |
| `packages/webapp/src/scoops/model-policy-file.ts`                    | `/etc/models` seeding, loading, live reload                                   |
| `packages/vfs-root/etc/models`                                       | Default model access policy template                                          |

---

## Device & gesture gates

Browser device-access APIs — `showDirectoryPicker` and the WebUSB / Web Serial /
WebHID `requestDevice` family — only run from inside a real user-gesture
handler. The kernel worker that hosts shell commands has no `window`, so these
APIs cannot run there directly. The panel terminal bridges the gesture; agent
`bash` calls fall back to an in-chat approval dip (`mount`) or fail with a
clear "needs a real user gesture" message (`usb`/`serial`/`hid`/`esptool`).

### Single gesture entry — `<slicc-permissions>`

Every gesture-gated picker (camera / microphone / USB / HID / serial / FS) and
folder-drop mount routes through ONE in-tab `<slicc-permissions>` web component
mounted in the leader tab. The element is published via the page-realm accessor
`getLeaderPermissionsSurface()` in
`packages/webapp/src/ui/wc/wc-permissions-registry.ts`, so every caller —
panel-RPC `permission-request` handler, terminal `<cmd> request` keystroke,
composer mic / PTT, composer photo / video capture, the cone-driven
`runDevicePickerApproval` chat card — reaches the same host without an ad-hoc
DOM query.

Camera and microphone are the kinds whose origin grant the browser already
persists (`navigator.permissions.query` → `'granted'`). Callers that would
otherwise re-show SLICC's Allow/Cancel overlay on every invocation pass
`skipIfGranted: true` on `surface.prompt()` so a persisted grant skips the
in-app dialog and acquires the stream directly. The browser prompt still
appears once per session (or until revoked). Gesture-bound kinds (screenshare /
USB / HID / serial / filesystem / popup) are never skipped. Composer
photo/video capture (`wc-attach.ts`), the `hear` command, and `ffmpeg
-f avfoundation` opt in. The panel-RPC `permission-request` handler defaults
the flag to `true` for camera/mic-only payloads so worker-initiated media
probes match. Callers that genuinely want a confirmation each time omit the
flag (or pass `skipIfGranted: false`).

The surface accepts injectable `providers` seams so the same contract works
across runtimes:

- **Standalone / Electron / hosted-leader / detached popout** — providers stay
  unset; the surface calls the platform defaults (`navigator.usb` /
  `navigator.hid` / `navigator.serial` / `window.showDirectoryPicker` /
  `navigator.mediaDevices`) directly inside the gesture handler.
- **Chrome extension** (`chrome.runtime.id` is set) — `wc-live.ts` injects the
  popup-backed providers from
  `packages/webapp/src/ui/wc/wc-permissions-providers.ts`. Each picker opens
  `chrome-extension://<id>/picker-popup.html` (`?kind=directory|usb-device|serial-port|hid-device`)
  in a normal browser window — the chooser runs on its own button click and
  posts identifiers back; the page-side provider re-acquires the granted device
  via `navigator.{usb,hid,serial}.getDevices()` (mount goes through the shared
  `slicc-pending-mount` IDB store) before handing it to the surface. The
  leader tab's `<slicc-permissions>` surface can't host the chooser reliably
  under TCC, which is why the popup is a parity requirement, not an
  enhancement.
- **Cherry follower** — the surface is intentionally NOT mounted; cross-origin
  iframes can't hold writable `FileSystemDirectoryHandle`s (Spike A), and
  followers focus the leader tab when they need a gesture instead.

The `runDevicePickerApproval` chat-card path
(`packages/webapp/src/shell/supplemental-commands/picker-approval.ts`) stays as
the agent-initiated entry point — the card's "Approve" button satisfies the
user-gesture rule, and the click handler dispatches `dip-picker-action` to the
page where `handleDipPickerAction` (`packages/webapp/src/ui/dip.ts`) runs the
picker. The extension branch — silently broken before this wave because
`mountDipExtension` never listened for `dip-picker-action` — now routes through
the same popup-window providers as the surface, so the cone-driven flow has
parity with the terminal keystroke path.

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
  `mount /<path>` line and runs `showDirectoryPicker` in the page realm while
  the Enter keystroke's transient activation is still live, stashes the handle
  in IDB, and forwards a rewritten command so the worker-side `mountLocal`
  adopts the already-granted handle. The line editor is the `xterm-readline`
  addon, so Enter resolves the addon's `read()` promise; the picker runs in the
  microtask that resolution schedules, which is still the same task as the
  keydown, so the activation carries through.
- **Agent-driven** — the `mount` shell command (run via `bash`) renders a Tool
  UI approval card in chat (`packages/webapp/src/shell/tool-ui.ts`). The
  user's click is the gesture; the click handler then calls the picker.

In the **extension**, the picker additionally routes through the shared
picker popup window (`packages/chrome-extension/picker-popup.html` —
`?kind=directory` mode — plus the shared helpers `openMountPickerPopup` /
`loadAndClearPendingHandle` / `reactivateHandle` in
`packages/webapp/src/fs/mount-picker-popup.ts`). The hosted leader tab the
SW pins cannot host macOS TCC (Transparency, Consent, and Control) permission
dialogs reliably and crashes when `showDirectoryPicker` is invoked there
against a system folder Chrome refuses to share (Documents/Downloads/Desktop/home).
All three extension-side mount entry points use the popup: the shell `mount`
command, agent-driven approval dips, and the welcome sprinkle's `request-mount`
lick.

Local mounts are cone-only because the directory picker requires a real user
gesture. S3 / DA mounts are allowed from scoops since their credentials come
from the secret store.

### `usb` / `serial` / `hid` / `esptool`

`usb request`, `serial request`, `hid request`, and `esptool` without `--port`
all call a WebUSB / Web Serial / WebHID device picker. Same gesture constraint
as `mount`.

The page terminal bridges the gesture identically: `RemoteTerminalView`
pre-intercepts a `<cmd> request` line on Enter, runs the picker in the page
realm, then forwards a rewritten command carrying `--__resolved <handle>` so
the worker-side command body looks up the already-granted device instead of
prompting. In the extension, the picker additionally routes through a
dedicated popup window (`usb-picker-popup.html` / `serial-picker-popup.html` /
`hid-picker-popup.html`) because the hosted leader tab cannot host
`requestDevice` reliably across all configurations.

Because the gesture must originate from a real keystroke, the picker
subcommands do **not** work from an agent `bash` tool call or a scoop with no
UI — only from the terminal in the leader tab (cone) or an extension popup.
Already-granted handles (from `*-list`/`*-request`) can be operated on from
any realm via panel-RPC. Chromium-only; unavailable in the cloud /
hosted-leader float.

### Authoring agent-driven approval UI

`packages/webapp/src/shell/tool-ui.ts` exposes the shared "show HTML, await
user click" primitive that agent-driven commands use to acquire a gesture in
chat; `packages/webapp/src/tools/tool-ui.ts` is its compatibility re-export.
See the [`adding-slicc-features` skill §14](../.agents/skills/adding-slicc-features/SKILL.md#14-add-interactive-tool-ui-approval-dialogs-forms)
for the API and HTML conventions.

### Files

| Path                                                                 | Role                                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webcomponents/src/overlay/slicc-permissions.ts`            | The `<slicc-permissions>` web component (camera/mic/USB/HID/serial/FS)                                                                              |
| `packages/webapp/src/ui/wc/wc-permissions.ts`                        | `installLeaderPermissionsSurface` — mounts the surface in the leader tab                                                                            |
| `packages/webapp/src/base/permissions-surface-registry.ts`           | Leader-surface singleton (bottom of the layer stack so `shell/` can look it up)                                                                     |
| `packages/webapp/src/ui/wc/wc-permissions-registry.ts`               | `getLeaderPermissionsSurface()` accessor — the single page-realm seam                                                                               |
| `packages/webapp/src/ui/wc/wc-permissions-providers.ts`              | Extension popup-backed providers (filesystem + usb + hid + serial)                                                                                  |
| `packages/webapp/src/kernel/remote-terminal-view.ts`                 | Terminal `<cmd> request` keystroke gesture → `surface.request(kind)`                                                                                |
| `packages/webapp/src/speech/composer-speech.ts`                      | Composer mic / PTT → `surface.request('microphone')`                                                                                                |
| `packages/webapp/src/ui/wc/wc-attach.ts`                             | Composer photo/video capture → `surface.prompt({ kinds: ['camera','microphone'], skipIfGranted: true })`                                            |
| `packages/webapp/src/speech/hear.ts`                                 | `hear` mic capture → `surface.prompt({ kinds: ['microphone'], skipIfGranted: true })`                                                               |
| `packages/webapp/src/shell/supplemental-commands/ffmpeg-command.ts`  | `ffmpeg -f avfoundation` camera/mic capture → `surface.prompt({ kinds, skipIfGranted: true })` (panel-RPC `permission-request` in the worker realm) |
| `packages/webapp/src/shell/supplemental-commands/picker-approval.ts` | Cone-driven `runDevicePickerApproval` chat card (`data-picker=…`)                                                                                   |
| `packages/webapp/src/ui/dip.ts`                                      | `handleDipPickerAction` — runtime-aware dispatch for picker dip clicks                                                                              |
| `packages/webapp/src/fs/mount-picker-popup.ts`                       | Extension popup helpers for the FS-Access picker                                                                                                    |
| `packages/chrome-extension/picker-popup.html`                        | Extension picker popup shell (mount + USB/serial/HID)                                                                                               |
| `packages/webapp/src/ui/panel-rpc-handlers.ts`                       | `permission-request` panel-RPC op (worker → surface → registry handle)                                                                              |

### Manual smoke checklist — `:8787` wrangler harness

After a release build, walk the unified surface end-to-end against the local
wrangler UI (`packages/cloudflare-worker/`, port `8787`) so the popup paths
exercise the deployed `picker-popup.html`. CI cannot drive `requestDevice`
dialogs headlessly.

For each row: launch the harness (see `docs/architecture.md` §thin-bridge
harness), then run the action in the listed surface and confirm the listed
outcome. ✅ = pass, ⚠️ = noted asymmetry, ❌ = regression — fix before merge.

| Action                                                                             | Surface              | Expected                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mount /workspace/scratch`                                                         | Panel terminal       | `picker-popup.html?kind=directory` opens → "Select directory" → chooser → mount appears in file tree                                                                                                                   |
| Drag a folder onto the panel                                                       | Folder drop          | `slicc-mount-pending` fires → mount appears (no popup; drop is the gesture)                                                                                                                                            |
| `usb request`                                                                      | Panel terminal       | `picker-popup.html?kind=usb-device` opens → chooser → `usb list` shows handle `usb1`                                                                                                                                   |
| Agent issues `usb request` (cone)                                                  | Cone-driven approval | Chat card "Connect USB device" → click → popup opens → grant → handle returned, no silent no-op                                                                                                                        |
| `hid request --vid 0x594d`                                                         | Panel terminal       | Popup with filters applied → chooser → multi-interface device registers EVERY matching interface                                                                                                                       |
| Agent issues `hid request`                                                         | Cone-driven approval | Card click → popup → grant → handle returned                                                                                                                                                                           |
| `serial request`                                                                   | Panel terminal       | `picker-popup.html?kind=serial-port` opens → chooser → `serial list` shows handle `serial1`                                                                                                                            |
| Agent issues `serial request`                                                      | Cone-driven approval | Card click → popup → grant → handle returned                                                                                                                                                                           |
| `esptool flash …` without `--port`                                                 | Panel terminal       | Routes through `serial request` popup; once granted, esptool drives the same handle                                                                                                                                    |
| Composer mic button (push-to-talk)                                                 | Composer             | `getUserMedia` prompt appears in the hosted leader tab (extension and standalone alike)                                                                                                                                |
| Composer "Take a photo" (add-menu)                                                 | Composer             | First capture: SLICC Allow/Cancel then the browser camera/mic prompt; later captures skip the in-app dialog and open the inline capture surface                                                                        |
| `ffmpeg -f avfoundation -i 0 -frames:v 1 photo.jpg` (after `ipk add @ffmpeg/core`) | Panel terminal       | First capture: `<slicc-permissions>` Allow/Cancel then the browser camera prompt → photo lands in VFS; later captures skip the in-app dialog. Denying surfaces a clean `camera permission denied` error and no capture |
| `hear` (mic capture)                                                               | Panel terminal       | First capture: SLICC Allow/Cancel then the browser mic prompt; later captures skip the in-app dialog and transcribe                                                                                                    |

Cancel / deny on each row to confirm the surface emits `slicc-permission-deny`
with `reason: 'cancelled'`; the picker dip should not stay open.

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

The composer's push-to-talk requests the microphone during the hold, through
`packages/webapp/src/speech/composer-speech.ts` (`requestPermission()` →
`navigator.mediaDevices.getUserMedia({ audio: true })`). The press is the user
activation, and the request is routed through the WC `<slicc-permissions>`
surface mounted in the hosted leader tab so the prompt shows in a context that
can host it. `packages/webapp/src/speech/hear.ts` shares the same acquisition
for the `hear` shell command, falling back to a direct `getUserMedia` when no
permission surface is mounted (early boot / non-WC realms). `hear` passes
`skipIfGranted: true` so a persisted origin grant does not re-show SLICC's
Allow/Cancel overlay on every invocation.

Composer photo/video capture (`packages/webapp/src/ui/wc/wc-attach.ts`) probes
camera + microphone through the same surface before mounting
`<slicc-composer-capture>`. It also sets `skipIfGranted: true`: the first
add-menu capture still shows SLICC's dialog (so Allow can prime both kinds
under one gesture), then later captures skip the in-app overlay the way the
browser already skips its own camera/mic prompt.

`ffmpeg -f avfoundation` (`packages/webapp/src/shell/supplemental-commands/ffmpeg-command.ts`)
gates camera/mic the same way — page-realm `surface.prompt({ skipIfGranted: true })`,
worker-realm `permission-request` with the same flag. The panel-RPC handler
also defaults `skipIfGranted` on for camera/mic-only payloads so a forgotten
flag still skips.

### Files

| Path                                                                       | Role                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/webapp/src/shell/supplemental-commands/screencapture-command.ts` | `getDisplayMedia` invocation                           |
| `packages/webapp/src/speech/composer-speech.ts`                            | push-to-talk `getUserMedia` via the permission surface |
| `packages/webapp/src/speech/hear.ts`                                       | `hear` command mic acquisition (`skipIfGranted`)       |
| `packages/webapp/src/ui/wc/wc-attach.ts`                                   | Composer photo/video capture (`skipIfGranted`)         |
| `packages/webapp/src/shell/supplemental-commands/ffmpeg-command.ts`        | `ffmpeg -f avfoundation` camera/mic (`skipIfGranted`)  |

---

## Transcript export — per-request human approval

### Summary

When a tray follower or a Cherry-embedded host requests a transcript export, a
human must explicitly approve each individual request before any data is sent.
Since #2062 that approval **is a sudo action** (`kind: 'export'`): it runs
through `SudoManager.approve()`, so a `NOPASSWD Export <glob>` rule pre-grants
it, "Always" on the prompt writes one, and the prompt itself goes wherever
sudo prompts go — including a tray follower's Face ID sheet when the leader is
headless or the human is on the phone. Without a grant, approval is one-time
per request.

### Threat model

The approval gate prevents a compromised follower or malicious Cherry host from
exfiltrating session history without the user's knowledge. Every export path
(tray follower and Cherry SDK) goes through the same approval dialog.

### Dialog contents

The approval dialog (`wc-transcript-export.ts`) shows:

- **Requester** — follower display name (tray) or host origin (Cherry).
- **Session** — "Active session" or "Archived session (ID: …)".
- **Estimated size** — derived from the stored snapshot or a live estimate.
- **Binary-attachment warning** — explains that binary files are sent unchanged
  and may contain sensitive data.

### Semantics

- **Allow once** — starts the export immediately; this approval covers exactly
  one transfer. A second request shows the dialog again.
- **Deny** (Escape / close) — rejects the pending Promise / request with
  `permission-denied`; no data is sent.
- There is no "Always allow" option for transcript export.

### Files

| Path                                                | Role                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/webapp/src/ui/wc/wc-transcript-export.ts` | `openTranscriptExportApproval()` — renders the dialog and returns Allow/Deny |
| `packages/webapp/src/transcript/export-service.ts`  | `TranscriptExportService` — verifies approval before streaming               |
| `packages/shared-ts/src/transcript-export.ts`       | `TranscriptExportErrorCode` union including `'permission-denied'`            |
| `packages/cherry/src/mount.ts`                      | Cherry host — sends `session.export.request`, awaits response                |

See [docs/transcript-export.md](transcript-export.md) for the full export flow.
