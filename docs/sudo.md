# Sudo — agent action approvals

SLICC can require a genuine **human approval** before the agent runs a sensitive
action. Approvals are driven by a sudoers-style policy at `/etc/sudoers` (plus
`/etc/sudoers.d/*` drop-ins) and enforced at two layers: the agent filesystem
and the shell command dispatch. The agent can _request_ an approval but can
never fabricate the decision — only a real OS dialog / `window.confirm` gesture
resolves it.

## What gets gated

| Layer             | Where                                   | Matches              |
| ----------------- | --------------------------------------- | -------------------- |
| Filesystem reads  | `read_file` tool + shell file reads     | `Read <glob>` rules  |
| Filesystem writes | `write_file`/`edit_file` + shell writes | `Write <glob>` rules |
| Commands          | each top-level segment of a `bash` line | `Cmnd <glob>` rules  |

The agent's FS handle is wrapped once with `createSudoFs`, and that single gated
handle backs both the file tools and the shell, so a `cat`/`echo >` in bash is
gated by the same `Read`/`Write` rules as the file tools. Denied commands exit
`1` with `sudo: approval denied`; denied file ops throw `EACCES`.

The **panel terminal is not gated** — the human typing there is already the
approver.

## `/etc/sudoers` format

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

## Self-protection (always on)

Writes to `/etc/sudoers` and anything under `/etc/sudoers.d/` **always** require
approval — a `NOPASSWD` rule cannot override this. It is hardcoded in
`matchPath` (`packages/webapp/src/shell/sudo/sudoers.ts`), independent of the
loaded policy. Reads of those files are allowed (visudo-style).

## Live reload

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

## Architecture

```text
Orchestrator.init()
  └─ new SudoManager({ fs: sharedFs, watcher })  // seed + load + watch
       ├─ getBroker()   → createSudoBroker()      // float-specific
       ├─ getPolicy()   → live merged SudoersPolicy
       └─ getShellConfig() → { getPolicy, broker, persistCommandGrant }

ScoopContext.init()
  ├─ gatedFs = createSudoFs(fs, { broker, getPolicy })  // FS-level enforcement
  ├─ createFileTools(gatedFs)        // file tools gated
  └─ new WasmShell({ fs: gatedFs, sudo: getShellConfig() })  // command-level
```

Brokers (`packages/webapp/src/sudo/`):

- **Extension** — `createExtensionSudoBroker` relays offscreen → side panel via
  `chrome.runtime.sendMessage`; the panel responder
  (`installPanelSudoResponder`, wired in `ui/main.ts`) raises the real
  `window.confirm`/`window.prompt`.
- **CLI / Electron** — `createHttpSudoBroker` POSTs `POST /api/sudo-approve`
  (`packages/node-server/src/sudo/`), which selects an OS-native backend
  (Electron / osascript / PowerShell / zenity / TTY).
- **Native macOS (swift-server)** — when Sliccstart launches the bundled
  `slicc-server`, `createHttpSudoBroker` POSTs the same `POST /api/sudo-approve`
  to `packages/swift-server/Sources/Server/SudoApprove.swift`, which raises the
  identical `osascript` dialog as node-server. Loopback-only (the server binds
  `127.0.0.1`) and fail-closed (`deny`) on any error, non-zero exit, dismissed
  dialog, or unparsable output.

All brokers **fail closed**: any transport error, malformed response, or missing
gesture resolves to `deny`.

## Files

| Path                                              | Role                                |
| ------------------------------------------------- | ----------------------------------- |
| `packages/webapp/src/shell/sudo/sudoers.ts`       | Parser + matcher + self-protection  |
| `packages/webapp/src/sudo/sudo-manager.ts`        | Live policy store + reload + broker |
| `packages/webapp/src/fs/sudo-fs.ts`               | FS-level gate (`createSudoFs`)      |
| `packages/webapp/src/shell/sudo/command-guard.ts` | Command-level gate                  |
| `packages/webapp/src/sudo/*-broker.ts`            | Float-specific approval brokers     |
| `packages/node-server/src/sudo/`                  | `/api/sudo-approve` + OS dialogs    |
| `packages/vfs-root/etc/sudoers`                   | Default commented-out template      |
