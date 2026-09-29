# Kernel Process Model

The kernel host (worker-resident in standalone, offscreen-resident in the extension) tracks every long-running async unit of work in a single `ProcessManager`. The model is intentionally Unix-flavored — pids, signals, `/proc` — so users and agents can reach for tools they already know (`ps`, `kill`).

This page is the deep reference. The repo navigation hub is `docs/architecture.md`.

## Where it lives

`packages/webapp/src/kernel/` — see the per-file table in `architecture.md`. The subsystem is single-instance per kernel host: one `ProcessManager`, one `/proc` mount, one `TerminalSessionHost`, all constructed inside `createKernelHost(config)`.

## Process lifecycle

Every long-running async unit in the kernel registers a `Process` record:

```ts
interface Process {
  readonly pid: number; // monotonic uint32 from 1024+
  readonly ppid: number; // 1 = kernel-host anchor (synthesized)
  readonly kind: ProcessKind; // 'scoop-turn' | 'tool' | 'shell' | 'jsh' | 'py' | 'net' | 'computer' | 'wasm'
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly owner: ProcessOwner; // { kind: 'cone' | 'scoop' | 'system' | 'jshd', scoopJid? }
  readonly abort: AbortController; // cooperative cancel
  readonly gate: Gate; // pause/resume
  readonly startedAt: number;
  status: 'pending' | 'running' | 'exited' | 'killed';
  exitCode: number | null;
  terminatedBy: Signal | null; // first non-SIGKILL wins; SIGKILL escalates
  finishedAt: number | null;
}
```

Status transitions: `running` → `exited` (clean) or `killed` (any terminating signal recorded). The manager fires `spawn` and `exit` events synchronously inside the corresponding method calls so `/proc` and `ps` see live state without a tick of latency.

### Retention

A terminated process is not dropped the instant it exits — `ps` after a `kill` has to be able to show the exit code — but it is not kept forever either. The manager retains the most recent `TERMINATED_RETENTION` (128) terminated records and reaps older ones oldest-first, so the table stays O(live + 128) instead of accumulating every command the session ever ran. Eviction only ever considers already-terminated pids, so a live process can never be reaped.

`stats()` carries the totals the reaped records used to:

```ts
{
  (live, retained, terminated, spawned);
}
```

`terminated` and `spawned` are monotonic for the session and keep counting past the retention window; `retained` is how many records are actually resident. Surfaces that want to say how much work ran (the monitor's "1,435 exited this session") read the counter — a number stays true without thousands of records having to stay resident to prove it.

Consequences worth knowing: `get(pid)` and `wait(pid)` on a reaped pid behave exactly like an unknown pid (`null` / reject), and `allocatePid()` may reuse a reaped pid after the uint32 space wraps.

## Where pids come from

| Kind         | Spawn site                                          | argv                                    |
| ------------ | --------------------------------------------------- | --------------------------------------- |
| `scoop-turn` | `ScoopContext.prompt()`                             | `['prompt', <truncated user text>]`     |
| `tool`       | `tool-adapter.ts adaptTool()`                       | `[tool.name, <principal string param>]` |
| `shell`      | `TerminalSessionHost.handleExec()` (panel terminal) | `[command-line]`                        |
| `shell`      | `ScoopContext.spawnBashJob()` (agent `bash` tool)   | `['bash', '-c', command]`               |
| `jsh`        | `executeJshFile` / `executeJsCode` (via realm)      | `['node', scriptPath, …args]`           |
| `jsh`        | `jshd start` (owner `jshd`, job id `jshd:<name>`)   | `['node', scriptPath, …args]`           |
| `py`         | `python` / `python3` shell command (via realm)      | `['python3', …]`                        |

The principal-arg extraction for tools (`extractToolArg` in `tool-adapter.ts`) tries an ordered list of known param names — `command` (bash), `file_path` / `path` (file ops), `pattern`, `url`, `key`, `name`, `query`, `message` — then falls back to the first non-empty string value. The `ps` formatter shell-quotes args with whitespace; a typical row reads `bash 'bash -c "date && sleep 8 && date"'`.

## Signals

| Signal    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGINT`  | Records `terminatedBy='SIGINT'`. Aborts `Process.abort.signal`. Releases the gate so paused waiters wake. Exit 130 by convention.                                                                                                                                                                                                                                                                                                                             |
| `SIGTERM` | Same as SIGINT but exit 143. Default for `kill <pid>` (no flag), matching POSIX.                                                                                                                                                                                                                                                                                                                                                                              |
| `SIGKILL` | **Escalates** — overwrites any prior `terminatedBy`. Exit 137. For `kind:'jsh'` and `kind:'py'` processes spawned by the realm runner, SIGKILL calls `worker.terminate()` (or `iframe.remove()` for the extension JS path) synchronously — the only way to hard-kill a CPU-tight `while(true){}` / `while True: pass` in the browser. For other kinds, SIGKILL still aborts cooperatively + force-exits the process record (the underlying promise may leak). |
| `SIGSTOP` | Pauses `Process.gate`. Subsequent IO-boundary `await proc.gate.wait()` calls block until SIGCONT.                                                                                                                                                                                                                                                                                                                                                             |
| `SIGCONT` | Resumes the gate. All waiters wake at once.                                                                                                                                                                                                                                                                                                                                                                                                                   |

First-wins applies only to `SIGINT` / `SIGTERM`. `SIGKILL` is uncatchable: it always overwrites `terminatedBy`, mirroring POSIX. The realm runner (`kind:'jsh'` and `kind:'py'`) is the only path with a hard-stop guarantee, and it applies that guarantee to **every** terminating signal, not just SIGKILL — see [Realm runner](#realm-runner).

## Pause / resume

`Gate` is a re-arming barrier: default-resumed; `pause()` builds a single internal Promise; `resume()` resolves it (waking every waiter); `release()` permanently locks the gate to "always resolved" (called from `pm.exit` so paused waiters don't deadlock at termination).

Today's gate awaits live at one IO boundary: terminal output emission in `TerminalSessionHost.handleExec`. SIGSTOP holds the wire-side `terminal-output` event behind `proc.gate.wait()`; SIGCONT releases it. Other boundaries (`VfsAdapter` methods, stdin reads in jsh, network bridge, just-bash command-boundary callbacks) are follow-up candidates.

The gate is purely cooperative. Pure-CPU `while(true){}` loops don't observe it — the realm runner (`kind:'jsh'`/`'py'`) is the answer for hard control.

## `/proc` filesystem

`createKernelHost` calls `vfs.mountInternal('/proc', new ProcMountBackend(processManager))` after the orchestrator boots. The mount is:

- **Internal**: `vfs.mountInternal` skips IDB persistence and BroadcastChannel sync. Records under a separate `internalMounts: Set<string>` so `listMounts()` excludes it.
- **Scoop-invisible**: `RestrictedFS.getAllPrefixes()` reads from `listMounts()` only. Scoops can't see `/proc` at all (so they can't introspect each other).
- **Read-only**: every write throws `EACCES` ("read-only filesystem" — `FsErrorCode` doesn't carry `EROFS`).

Layout:

```
/proc/                  # one directory per live pid + the synthesized 1
/proc/<pid>/status      # human-readable Name/Pid/PPid/State/Owner/StartedAt/Cmdline
                        # plus FinishedAt/TerminatedBy/ExitCode for terminated procs
/proc/<pid>/cmdline     # argv joined by NUL bytes with trailing NUL (POSIX procfs)
/proc/<pid>/cwd         # plain text path
/proc/<pid>/stat        # single-line: pid (kind) state ppid exit started finished
/proc/1/                # synthesized kernel-host anchor, ppid=0
/proc/table             # the whole retained table as one JSON document
```

Deliberate omissions: no `/proc/self` (would require `currentPid()` tracking which we don't do), no `environ` (would leak masked secrets), no `fd/` or `task/`. The full Linux procfs surface is out of scope; just what `ps` and `kill` need to drive their views.

One deliberate ADDITION: `/proc/table` has no Linux counterpart. Linux readers walk `/proc/<pid>/` per process because a syscall-backed read is cheap; here every read crosses the VFS, so a UI refreshing the process list paid a `readDir` plus two `readFile`s per pid — thousands of VFS reads per tick against the same VFS the boot path and the terminal mount contend for. `/proc/table` collapses that to one read, and carries the `stats()` counters, which no per-pid file can express:

```jsonc
{
  "stats": { "live": 9, "retained": 137, "terminated": 1435, "spawned": 1444 },
  "processes": [
    {
      "pid": 1024,
      "ppid": 1,
      "kind": "shell",
      "state": "R",
      "status": "running",
      "argv": "sleep 9",
      "cwd": "/workspace",
      "owner": "cone",
      "startedAt": 1700000000000,
      "finishedAt": null,
      "exitCode": null,
    },
  ],
}
```

`processes` holds every RETAINED process (live plus the retention window), so a reader that only wants live ones filters on `status` — the same choice `ps` makes by default. `argv` is space-joined here, unlike the NUL-separated `cmdline` file: this is JSON, not procfs.

## `ps` and `kill`

`ps` (default) lists `running` and `pending` processes only. `-a` / `-A` / `-e` / `--all` includes the dead. Tree mode (`-T`) walks `ppid` links and indents children with `└─`. The default `SCOOP` cell is `cone`, `system`, `jshd`, or a 10-character prefix of the scoop jid, so the fixed table stays aligned. Naming `scoop` in `-o` / `--columns` (`ps -o scoop,stat,pid`) prints that jid in full. `STAT` and `PID` are the same fields either way. `COMMAND` stays capped at 80 characters.

`kill` defaults to SIGTERM (POSIX). Short forms: `-INT`, `-TERM`, `-KILL`, `-STOP`, `-CONT`, `-9`. Long form: `-s SIGINT`. Multiple pids in one call. Exit codes: 0 if every signal landed; 1 if any pid was unknown / already terminated; 2 on parse error.

## Realm runner

`runInRealm(opts)` spawns a per-task realm — a `DedicatedWorker` (standalone JS, both-mode Python) or a per-task sandbox iframe (extension JS) — and registers a `kind:'jsh'` (for `kind:'js'`) or `kind:'py'` process. The runner subscribes to `pm.onSignal` and escalates **every** terminating signal that reaches its pid to a synchronous `realm.terminate()` (`worker.terminate()` / `iframe.remove()`, both uncatchable), exiting 137 / 130 / 143 per the POSIX 128+signo convention. Realm code is opaque from the kernel side — there is no cooperative cancel hook to await — so a recorded-but-not-terminated SIGINT would leave the realm running forever (#1116). SIGSTOP / SIGCONT are pause/resume and are ignored here.

Stdout/stderr are streamed to the host as they are written (`realm-output`), and cache-only `writeFileSync`/`appendFileSync` posts (`realm-fs-write`) are applied to `ctx.fs` immediately, so a SIGKILL / `timeout` still returns the pre-hang output and completed file writes (#3136). `realm.terminate()` then runs; a `--- killed after <N>s (exit <code>) ---` trailer is appended. Writes that had not yet posted are best-effort only (SIGKILL-class). The same protocol is used in the standalone worker, the extension iframe, and the in-process test factory.

`runInRealm` takes **no** `AbortSignal`: `pm.signal(pid, …)` is its only stop path. Anything that wants to preempt realm-backed work must therefore own a pid the realm parents under, which is what the bash job below is for.

The user-facing surface is the `node` (`-e`/`script.js`/stdin / `--check`), `.jsh` discovery, and `python`/`python3` (`-c`/`script.py`/stdin) commands. Realm code runs inside an `AsyncFunction` (JS) or Pyodide (Python) with shimmed `console`, `process.argv`/`sys.argv`, `process.env`, `process.stdout`/`process.stderr`, `process.exit(N)` / `process.exitCode` / Python `SystemExit`. After the JS entry settles, the realm keeps the worker alive while ref'd handles remain — pending RPC (fs/exec/fetch), user timers, and in-flight WHATWG stream I/O (`Request`/`Response`/`Blob` body reads, `ReadableStream` `read`/`pipeTo`) — matching Node's event-loop keep-alive; `process.exit()` skips that drain. A mere `process.exitCode = n` assignment does **not** skip the drain: the realm waits for handles, then exits with `n` (#3155). An uncaught throw still exits 1. A macrotask hop after each handle settles lets the continuation after `await fetch()` (including `await res.json()` / `res.text()`, which read the already-buffered body) run before teardown. Constructed `Request`/`Response`/`Blob` body reads, `body.getReader().read()`, and `pipeTo` are counted as handles until the native stream settles, so a later stream read cannot silently exit 0 (#3227). A pending `WebAssembly.compile`/`instantiate` and `__slicc_mountVfs` count too, so an Emscripten program's `main` runs before teardown. Request/Response constructors are not replaced, so `instanceof Request` and `req.clone()` keep platform identity. The realm-host on the kernel side proxies `vfs` (read/write/list/etc.), `exec` (just-bash subcommand), and `fetch` (SecureFetch with secret substitution) over the realm's port, so realm scripts get a full Node-like surface without holding kernel-side state.

## Bash jobs (agent `bash` tool)

Every `bash` tool call registers a `kind:'shell'` job (`ScoopContext.spawnBashJob`) in addition to the `kind:'tool'` record the tool adapter already spawns. The job pid is passed as the third argument of `AlmostBashShell.executeCommand`, so any realm-backed command inside the run (`node`, `python3`, a `.jsh`) parents under **that job** rather than under the whole turn. That parentage is what makes preemption real: `pm.signal(jobPid, 'SIGKILL')` fans out over the ppid tree and the realm runner terminates each realm worker synchronously.

| Event                                 | Effect                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `timeout` reached                     | SIGKILL the job pid (fan-out terminates realm descendants) + cooperative abort; record reaped with the derived signal exit code |
| `background_after` reached            | The agent stops waiting; the job record stays `running`, so `ps` lists it and `kill <pid>` reaches it                           |
| Detached job finishes                 | Record reaped with the command's exit code; a `bash` lick carries the code, a preview, `resultPath`, and the pid                |
| Detached job killed by `timeout`      | Same reaping; `resultPath` keeps pre-kill teed output plus a `--- killed after <N>s (exit 124) ---` trailer (#2415)             |
| Normal turn end (`pm.exit(turnPid)`)  | No cascade — a detached job survives to deliver its lick                                                                        |
| Turn cancel / `stop()` / `drop_scoop` | Those SIGNAL the turn pid, so the fan-out reaps the job and its realm descendants                                               |
| `ScoopContext.dispose()`              | SIGKILLs every pid still in `liveBashJobPids` (see below), then tears the context down                                          |

**Reaping detached jobs at scoop teardown.** A detached job outlives its turn on purpose, so by dispose time the turn record it was parented to is usually gone and the turn-pid SIGTERM in `dispose()` cannot reach it. `ScoopContext` therefore tracks live job pids in `liveBashJobPids` (added at spawn, removed as each job exits or is killed) and SIGKILLs whatever remains. Without it a `drop_scoop`, or the automatic teardown of a one-shot `agent` scoop, would delete the scoop directory and leave the command running against it — with its output no longer persistable and its lick discarded.

**Per-run parentage under concurrency.** Detaching makes several runs share one `AlmostBashShell`, so the single `activeShellPid` field is no longer sufficient: a detached run that spawns its realm child late would otherwise attach it to whichever run started most recently. just-bash passes each command context the `signal` its exec was started with, so the shell keeps a `WeakMap<AbortSignal, number>` (`jobPidByRunSignal`) and `buildJshProcessConfig(runSignal)` prefers it, falling back to `activeShellPid` (panel terminal) and then `getCurrentShellPid` (turn pid). Pinned by `tests/scoops/scoop-realm-parenting.test.ts`.

**What is still not preemptible.** just-bash builtins (`grep`, `sed`, `jq`, …) execute in the kernel worker itself, so there is no worker to terminate: a SIGKILL on the job aborts cooperatively and just-bash observes it only at its next statement boundary. A single CPU-bound builtin blocks the worker's event loop, which also means the detach and timeout timers cannot fire while it runs. Closing that gap would mean hosting just-bash in a realm as well, which the ~108 kernel-resident supplemental commands (CDP, sudo brokers, secrets, orchestrator) currently rule out.

## jshd units

`jshd` is a pm2-style supervisor for long-running `.jsh` scripts (dev servers, watchers, skill-side daemons). Each unit is one realm worker plus one `ProcessManager` process (`kind: 'jsh'`, owner `{ kind: 'jshd' }`). Provider credentials are not injected. `ps` lists it; `kill <pid>` stops it.

Unit records live in `/workspace/.jshd/<name>.json` (argv, cwd, env, restart policy, enabled, createdAt). Logs are tee'd incrementally to `/workspace/.jshd/log/<name>.log`, the same idea as detached bash-job output.

**Restart vs stop.** `kill <pid>` and `jshd stop` mean stop: they do not restart. Only the restart policy (`always` / `on-failure` / `no`, default `always`) relaunches a unit that exited on its own. Backoff is exponential (1s … 30s). Eight failures inside 60s mark the unit `errored` and emit a `jshd` lick.

**Keep-alive** is the realm's existing handle semantics: a pending timer or host-event subscription (`RealmRpcClient.onEvent`) keeps the worker up; a script that returns with nothing pending exits and is subject to the restart policy.

**Boot restore.** Kernel-host step 9 awaits mount recovery, then awaits jshd restore, then bootstraps the cone. `createKernelHost` does not return (and the first turn cannot start) until enabled units have been relaunched. Restored units get a kernel-owned headless-shell context (canonical `PATH` / `HOME` plus a real `exec` bridge) with the persisted unit env overlaid, wrapped in the cone's `SudoFS` so writes to `/etc/sudoers` still require approval. Restricted scoop shells cannot start or mutate units.

**Job table.** Live units are also recorded in `kernel/job-table.ts` (`id: jshd:<name>`) so a future `jobs` / `fg` / `bg` (#2846) can list them next to detached bash jobs.

**Floats.** Real wherever `Worker` exists (standalone, Electron, cloud leader). The thin extension runs JS realms as per-task sandbox iframes, so `jshd start` is best effort there and `jshd ls` reports the unit is not durable.

## Synchronous filesystem bridge

Realm scripts (`.jsh` / `node -e` / `python3`) need synchronous filesystem
access to satisfy Node's `fs.readFileSync` / `writeFileSync` API shape. The
bridge (`realm/sync-fs-*.ts` + `ui/sync-fs-sw-handler.ts`) implements this
without _requiring_ `SharedArrayBuffer` or cross-origin isolation, so it
works on every float — including embedded leaders (Cherry, spoon/Electron)
that can never be isolated. The hosted leader document _is_ now
cross-origin isolated via `Document-Isolation-Policy` (per-document, no
COOP/COEP, SW control unaffected — see the `serveSPA` comment in
`packages/cloudflare-worker/src/index.ts`). Where `crossOriginIsolated` is
true the bridges take the **Atomics/SharedArrayBuffer fast path** below; the
SW sync-XHR path remains the universal baseline everywhere else:

**Atomics/SAB fast path (isolated leaders, #2043)**: `realm-runner` allocates
one `SharedArrayBuffer` per realm that owns its thread (`Realm.isolatedThread`
— a `DedicatedWorker`; never the in-process factory, which would deadlock
against its own responder) and hands it over in `RealmInitMsg.syncSab`. The
realm (`realm/sync-sab-bridge.ts`) posts the structured request on its control
port and blocks in `Atomics.wait`; the kernel-side `realm/sync-sab-responder.ts`
— attached to the same port by `attachRealmHost` — runs it through the SAME
token-scoped `dispatchSyncFs` / `dispatchSyncExec` as the SW route (identical
ACL, sudo, errno), writes the encoded result into the shared window and
`Atomics.notify`s. Results larger than the window stream in rounds
(`sync-sab-next`), one post per chunk, so the kernel never blocks and needs no
`Atomics.waitAsync`. The body carries no token: the port is private to one
realm, so the responder binds the host-minted token itself. Layout + encode/
decode live in the dependency-free `realm/sync-sab-wire.ts`. On this path the
SW-confirmation gate (`syncFsBridgeEnabled`) is not required to mint the realm's
token — the SAB is the transport — and `ENOSYNC` never reaches user code: every
over-cap or post-snapshot read falls through to a live, unbounded, chunked read.

**Fast path**: an in-memory snapshot of up to 500 files / 1 MB total / 10 MB
per file, warm-populated at realm start. Reads that hit the snapshot return
immediately with zero RTT.

**Fallback path**: on a cache miss (`ENOENT`), over-cap (`ENOSYNC`), or any
write, the bridge fires a **synchronous XHR** to `/__slicc/fs-sync/*`. The
page's controlling Service Worker (`llm-proxy-sw`) intercepts it and answers
over a per-session `slicc-sync-fs-<nonce>` BroadcastChannel — one channel per
live leader tab. The kernel-worker responder (`realm-host`) answers reads and
writes against the calling realm's own `RestrictedFS` (ACL + sudo + POSIX errno
preserved); the SW fans each request to all registered responders, and only the
one holding the matching nonce token replies. Responses carry an `x-slicc-fs`
marker so a stale-SW SPA-fallback can't masquerade as file bytes.

**Authorization**: `sync-fs-token-registry.ts` mints a per-realm capability
token in `attachRealmHost`; the token is revoked on `dispose`. Only the owning
realm's `ctx.fs` is reachable — scoops cannot cross-read each other.

**Enabled only when the controlling SW is confirmed**: `syncFsBridgeEnabled` is
threaded page → worker via `spawn.ts` / `KernelWorkerInitMsg` →
`sync-fs-enabled.ts` → the jsh executor. When a controlling SW is absent
(in-process test factory, CI) the bounded snapshot is used exclusively; a
synchronous XHR there would deadlock.

**Cold-start (MV3 SW eviction)**: after a SW eviction and respawn,
`controllerchange` does not re-fire for existing clients. `wc-live.ts`
re-publishes the nonce on tab `focus`/`visibilitychange` (proactive re-arm). A
genuinely cold operation waits up to `SYNC_FS_NONCE_WAIT_MS` for the re-arm
before failing closed — the first operation after a respawn succeeds rather than
producing a spurious `EIO`.

### Method surface (`createSyncFsBridge`)

Supported — all route through `ctx.fs`:

| Group | Methods                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read  | `readFileSync`, `existsSync`, `accessSync`, `statSync`, `lstatSync`, `readdirSync`, `realpathSync`                                                                      |
| Write | `writeFileSync`, `appendFileSync`, `truncateSync`, `mkdirSync`, `rmdirSync`, `rmSync`, `renameSync`, `copyFileSync`, `cpSync`, `mkdtempSync`, `unlinkSync`, `chmodSync` |

Unsupported (not implemented): fd-based (`openSync`/`readSync`/…) and symlink
ops. `lstatSync ≡ statSync` and `realpathSync` is lexical-only (no symlink
model). `accessSync`/`chmodSync` are existence-gated no-ops. `appendFileSync`,
`truncateSync`, `copyFileSync`, and `cpSync` compose read (cache → bridge) +
write-through, so an over-cap or post-snapshot source copies its real bytes
(never a silent 0-byte). File-body writes are durable at call time: the
bridge path write-throughs to `ctx.fs` synchronously; the no-bridge path
posts `realm-fs-write` to the host immediately (and still flushes the cache
diff at exit as a retry). A killed realm therefore keeps completed
`writeFileSync`/`appendFileSync` work (#3136).

## Synchronous exec bridge

`child_process.execSync` / `execFileSync` / `spawnSync` ride the same
transport. `realm/sync-xhr.ts` (`synchronify`) holds the blocking round-trip
both channels share — marker gate, errno recovery, fail-closed transport — so
the fs and exec channels differ only in route and payload.

**Route**: `POST /__slicc/exec-sync` with a JSON command envelope (the command
never has to survive URL encoding). The envelope also carries optional `cwd`
and `env`; `cwd` is stated against the token's filesystem (missing → `ENOENT`)
and `env` replaces the child environment (`replaceEnv: true`). Replaced
variables are marked exported so a nested `sh -c` / `bash -c` inherits them
the same way a directly-executed binary does. The kernel-worker responder
resolves the same per-realm token and dispatches through the realm's own
**`ctx.exec`** — the handle the async `exec` RPC uses — so the sudo command
guard, path ACLs, and secret masking are inherited unchanged. The token entry
widened from `{ fs, cwd }` to `{ fs, exec, cwd }`; one token covers both
channels because they share a mint site, a lifetime, and a revocation, and a
realm that can drive `ctx.exec` can already reach the filesystem through the
shell.

**Sudo while blocked**: the realm worker is blocked on the XHR, but the sudo
brokers live in the kernel worker (HTTP) and the page (panel-RPC), so an
approval prompt still renders and resolves — the blocked thread is never on the
approval path.

**Timeout**: a file read finishes in milliseconds, a build command does not, so
the exec channel derives its budget from Node's `timeout` option (default 2
minutes, capped at 10). The responder aborts the in-flight `ctx.exec` at the
budget, and its dedupe TTL is derived from the larger of the two channel
budgets so a late SW re-post replays the cached result instead of re-running
the command. On the SAB transport (a cross-origin-isolated page) a call with
no `timeout` has **no** deadline, as in Node: `Atomics.wait` can block
indefinitely, and a build's `$(MAKE) -C sub` or a Python `os.exec` hand-off to
`cmake` outlives any default. Realm disposal (SIGKILL, Ctrl+C) still aborts it.
The SW route keeps the default, because its fetch event must settle.

**Liveness deadline (no responder)**: those budgets bound how long a responder
that TOOK the work may take; a separate, much shorter deadline bounds the case
where no responder took it at all. The responder acks the instant it picks a
request up — before doing any work — and the SW re-posts every 200 ms until
that ack arrives, so the ack means "somebody is alive and owns this token". If
no ack lands within `DEFAULT_NO_RESPONDER_MS` (10 s, ≈50 delivery attempts),
`handleSyncFsRequest` fails closed immediately with the usual `503` +
`x-slicc-fs-errno: EIO` rather than serving out the rest of the budget. So an
unacked request surfaces `EIO` after ~10 s even on the exec channel, where the
budget alone would have blocked the calling realm for up to 10 minutes.

This matters because the wait is _synchronous_: the realm worker that issued
the request runs nothing until it returns, which includes the responder it
hosts. Without the deadline a stalled responder is self-sustaining — blocked
workers cannot answer each other, and each call burns its full budget before
even retrying. An **acked** request is unaffected and keeps its whole budget.

**Cache coherence**: the async exec bridge does flush-before / re-snapshot-
after; neither await exists here. Instead the sync bridge flushes pending
`SyncFsCache` mutations over the blocking fs channel (which is why the fs route
also carries live `mkdir` / `rm`), then **invalidates** the cache after the
command rather than re-snapshotting — every sync read already falls through to
the live bridge on a miss, so invalidation is correct and far cheaper. That
fall-through covers the removals too (`rmSync` / `rmdirSync` / `unlinkSync` /
`renameSync`): after an invalidate a cache miss is not proof of absence, so a
miss deletes through the live bridge and tombstones the path. `renameSync` of a
live-only **directory** is the one gap — a recursive live walk over a blocking
XHR is too expensive, so it raises `EISDIR`.

**No bridge → throw**: without a controlling SW there is no way to block on a
host round-trip, so the sync forms throw a message naming `promisify(exec)`.
`spawnSync` reports it on `.error` instead (it never throws).

**Not killable mid-call**: a blocked `execSync` cannot be SIGINT'd; only realm
`worker.terminate()` (SIGKILL, exit 137) reaches it. Realm disposal then revokes
the sync token, which aborts the in-flight `ctx.exec` too (`trackSyncExec`), so
a killed realm cannot strand a running command.

## Emscripten tools in the JS realm (`__slicc_mountVfs`)

A realm with a sync fs bridge publishes `globalThis.__slicc_mountVfs(FS, { cwd })`
(`emscripten-vfs-hook.ts`, lazily imported). A wasm tool built with a classic
Emscripten `FS` (`-sFORCE_FILESYSTEM`, `FS` + `callMain` exported,
`-sINVOKE_RUN=0`) calls it after runtime init and before `callMain`: every
top-level VFS dir (except `/dev`, `/proc`) is mounted through `SLICC_LIVE_FS`
(`live-vfs-fs.ts`, the same plugin the Pyodide realm uses) at its own path, and
the module chdirs to `cwd`. The tool then reads and writes the live VFS —
mounts included, under the realm's ACLs — with no copy in or out.

The returned handle has `flush()` (write back the tool's open dirty buffers —
call before spawning a child) and `invalidate()` (drop cached nodes — call after
a child ran). Coherence with the realm's own `SyncFsCache`: pending sync writes
are flushed before the mount and before each tool mutation (so the tool sees a
pending `mkdirSync`, and a pending `rmSync` can't later delete its output), and
every tool mutation then invalidates the cache — in a `finally`, and even before
the script's first sync `fs` call (the boot snapshot may be stale) — so a later
`fs.readFileSync` sees the tool's output. Large modules compile host-side through
`__slicc_compileWasm`; a 68 MB `clang.wasm` compiled and instantiated in
~90 ms on an isolated leader.

just-bash runs any executable file as a **bash** script (it ignores `#!`), so a
tool's launcher on `PATH` is a one-line bash script, e.g.
`node /opt/toolchain/run.js clang "$@"`.

## Wasm realm processes (`wasm`)

The wasm realm (#3530) runs a wasm program as a process of its own: one `DedicatedWorker` per process, without the node realm's shims. `spawnWasmProcess` (`kernel/wasm-realm/host.ts`) registers nothing itself; the `wasm` command records a `kind:'wasm'` process (parented like a `node` realm, so a job's signal fans out to it) and turns a terminating signal into `worker.terminate()` (137 / 130 / 143).

- **Descriptors are the kernel's.** Each process has an `FdTable` of reference-counted open file descriptions: pipe ends, a byte source (the command's stdin), output sinks. A pipe (`KernelPipe`) blocks a reader until data or EOF and a writer while full, and fails a writer with `EPIPE` once every reader is gone, so `yes | head -1` ends. A process's exit (or kill) releases its descriptors.
- **Syscalls ride the SAB bridge.** fds 0-2 of the Emscripten program are wired to `fd-read` / `fd-write` requests over the same Atomics/SAB transport and responder the sync bridges use, with a dispatcher that sends syscalls to the process and file operations to the token-scoped `dispatchSyncFs`. A read on an empty pipe keeps the worker in `Atomics.wait`; the kernel answers when data arrives.
- **Files** are the live VFS, mounted into the program's FS as `__slicc_mountVfs` does (below), plus the shell's synthetic command registry (`/usr/bin`, `/bin`), so a program that searches `$PATH` itself (make) finds every command. A file's inode number is the backend's (ZenFS, hostfs: the same across rewrites, new for a file replaced at its path), else a hash of its VFS path (S3, DA), never the module's own node id: that differs from process to process, and the stat data git keeps in its index would never match in the next git process. A file unlinked while open (mkstemp, unlink, write, read back — how `tac` and `sort` stage a pipe) lives on in memory for its streams and is never written back. Every file a program stats — VFS, its own memory FS, pipes, sockets, terminals, devices, `/dev/fd` — is owned by uid/gid 1000 (`realm-user.ts`, one wrapper over the FS's `stat`/`fstat`), the user the toolchain's `slicc_libc_gaps.c` makes `getuid()` and friends answer, so ownership checks hold (git's `safe.directory`, bash's `-O`, `tar`'s owner column). The VFS keeps no owners and `chown` changes nothing, so nothing is root.
- **Pipes** a program makes (`pipe()`) are kernel pipes too (`kernel-streams.ts`): every kernel-backed stream is refcounted across dup / dup2 / the fork emulation's cloned fd table and closes its kernel descriptor with the last copy, so a pipe handed to a child is shared with the child's worker and reaches EOF when its last writer goes. A kernel-backed stream other than a VFS file has no offset: lseek fails with ESPIPE (its placeholder's `/dev/null` seek would succeed, and GNU bash would then read a pipe ahead and seek back, so `cmd | while read l` lost every line but the first). A write to a pipe with no reader ends the writer with 141 (SIGPIPE's default action), so `yes | head -1` ends quietly — unless the program ignores or handles SIGPIPE (`tee -p`, `signal(SIGPIPE, SIG_IGN)`), which the runtime asks the toolchain's exported `slicc_sigpipe()`: then its handler has run and the write fails with EPIPE.
- **Sockets** (`socket.ts`, `socket-syscalls.ts`, `process-sockets.ts`, #3571): a virtual loopback network, so native programs and TypeScript kernel services talk over `127.0.0.1` without the host's network. A socket is a kernel open file description (`KernelSocket`) in the process's `FdTable`, so `dup`, fork, exit and `select`/`poll` treat it like a pipe end; a connection is two bounded `KernelPipe`s, one per direction (EOF on the peer's close or `shutdown(SHUT_WR)`, EPIPE — and SIGPIPE unless `MSG_NOSIGNAL` — once the peer stopped reading). `AF_INET` stream sockets bind any `127.x.x.x` (or `0.0.0.0`) by port, ephemeral ports come from 32768–60999, and `AF_UNIX` binds a path in the namespace (no file appears on the VFS; `socketpair` too). `connect()` completes at once against a listener's backlog, as TCP does before `accept()`; with no listener it is ECONNREFUSED, a full backlog too, and any address off loopback is ENETUNREACH — nothing leaves the realm. A non-blocking `connect()` still reports EINPROGRESS (the socket is writable at once and `SO_ERROR` is 0), which is what curl waits for. `accept` blocks like a pipe read, interruptible by a caught signal (EINTR, retried under SA_RESTART); O_NONBLOCK (`fcntl`, `SOCK_NONBLOCK`, `accept4`) and `MSG_DONTWAIT` make reads, writes and accepts answer EAGAIN, and `MSG_PEEK` leaves the bytes. `setsockopt` keeps every value for `getsockopt` (TCP_NODELAY, SO_KEEPALIVE, SO_REUSEADDR change nothing on pipes); `SO_TYPE`, `SO_ERROR`, `SO_ACCEPTCONN`, `SO_DOMAIN` and the buffer sizes are the kernel's answers. **Namespaces are per process owner** — each cone, each scoop, and the system (`loopbackNet(ownerKey(owner))`, keyed by the owner's kind and JID like `ps`'s SCOOP column; the panel terminal's shell runs as the system, the agent's `bash` tool as its cone): a namespace lives as long as the kernel worker, so a kernel service, or a server one of the owner's `wasm` invocations runs (in the panel's login shell, say), is reachable from the owner's other invocations, and a scoop cannot reach the cone's listeners. A listener lives as long as its descriptor: it closes with the process that holds it. A **kernel service** listens with `LoopbackNet.listen(addr)` and serves what `accept()` returns (`read`/`write`/`shutdown`/`close` on a `KernelSocket`); `LoopbackNet.connect(addr)` is its client side. In the program, the toolchain's `slicc_socket.c` replaces Emscripten's socket syscalls (whose SOCKFS maps a socket to a WebSocket and cannot listen in a browser) with `Module.sliccKernel.net`: each socket is an `S_IFSOCK` stream of the program's FS attached to its kernel descriptor, so `read`/`write`/`close`/`dup`/`fcntl` work on it, and `getaddrinfo` resolves `localhost` (and `*.localhost`) and numeric IPv4 with no DNS (every other name is EAI_NONAME; the realm has no IPv6, so `socket(AF_INET6)` is EAFNOSUPPORT). It also routes musl's `select()` through `slicc_select.c`'s kernel-backed `poll`, so link both shims. Proven with a C client/server (`tests/fixtures/wasm-sockets/socktest.c`) and plain-HTTP curl 8.22.0 against TS listeners, as real wasm-realm processes in worker threads (`wasm-sockets.test.ts`).
- **Network** (`net/`, #3571): each owner's namespace has an HTTP proxy on `127.0.0.1:3128` (`proxy-service.ts`), a TypeScript kernel service started by the first connection to that port (socket activation, `LoopbackNet.activate`, `realm-network.ts`) and living as long as the namespace; it shows in `ps` as a `net` process of its owner, and a signal stops it until the next connection. Native programs start with `http_proxy` / `https_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` pointing at it and `no_proxy` / `NO_PROXY` covering the realm's own loopback, under the shell's exports (an exported value, even an empty one, wins). The proxy forwards absolute-form HTTP/1.1 requests through the float's fetch path (`RealmTransport`, `transport.ts`), so secrets behave as for the shell's `curl`: a masked value is unmasked where the request leaves and real values coming back are masked there (`docs/secrets.md`). Responses stream back chunked, one chunk at a time, with a slow client slowing the upstream read; connections are kept alive and pipelined requests answered in order; `Expect: 100-continue` is answered; bounds cover connections served at once (64, the rest wait in the backlog), head size, request body size (the transport's cap, 32 MiB today, buffered), request bytes buffered across connections and time between reads. A request for the realm's loopback (`localhost`, `127.x`) is 403, never sent to the host's. `CONNECT host:port` is terminated (`tls-tunnel.ts`): the proxy speaks TLS 1.2/1.3 to the client as `host` with a leaf the owner's realm CA issued for it (a P-256 key pair generated in the Mbed TLS engine, `@ai-ecoverse/wasm-tls-engine`, loaded lazily on the first tunnel; only its public key leaves the engine), offers only `http/1.1` by ALPN, refuses an SNI naming another host, and serves the requests inside as requests for `https://host[:port]` through the same forwarding (a `Host` or absolute target for another origin is 421). Leaves are cached per host and reissued a day before their week is up. The **realm CA** (`realm-ca.ts`, `x509.ts`) is one per owner: an ECDSA P-256 WebCrypto key generated **non-extractable** in the kernel worker and kept in IndexedDB (`slicc-realm-ca`; structured clone keeps it non-extractable), so no script, the kernel's included, can read the key's bytes and no VFS path reaches it; it only signs. Its public certificate is written to `$HOME/.config/slicc/realm-ca-<owner>.pem` before a program starts, and `SSL_CERT_FILE` / `CURL_CA_BUNDLE` / `GIT_SSL_CAINFO` point at it (under the shell's exports, like the proxy variables, and kept out of what GNU bash carries into the shell's environment). Nothing else trusts it: the realm's programs reach the outside only through this proxy. The transport is the proxied fetch's raw mode where the float has one (`raw-transport.ts` over `createProxiedStreamingFetch({ mode: 'raw' })`: a 3xx reaches the client with its `Location`, every `Set-Cookie` stays separate, bodies are decoded with their headers made to match and pulled as the proxy writes, and a raw failure's own status — 413, 403 — is what the client gets). Where it has none (a node-server or Sliccstart bridge that predates raw mode — detected up front, or from the first request's `unsupported`) the proxy falls back to the browser-shaped proxied fetch (`fetch-transport.ts`), with its reduced semantics: redirects followed, bodies decoded, no streaming through the extension Port. A request body is buffered up to the transport's cap, and never more than the proxy buffers across connections.
- **Children** (`children.ts`, `process-children.ts`): the runtime publishes `Module.sliccKernel`, which the toolchain's `posix_spawn` / `waitpid` shims (`slicc_spawn.c`) call. `proc-spawn` builds the child's descriptors from the parent's: a slot that is one of the parent's kernel fds is shared, so the child runs concurrently (`make -j`); a slot on a file or pipe inside the program's own FS gets that descriptor's current bytes as stdin or a capture buffer the runtime writes back after waiting, so such a spawn returns when the child is done. The module's own `/dev/null` is neither: the child gets a null descriptor and the spawn returns at once (a forked child that must not wait before its exec, as git's `start_command` for a helper whose output it discards). `proc-wait` parks the worker until a child exits (`WNOHANG` answers at once). The `wasm` command's `WasmSession` (`wasm/launch.ts`) resolves what to run: an installed command (bare name or `/usr/bin/<name>`) or a glue path with its module runs as another wasm-realm process, parented to its spawner in the process table; a path whose first line is `#!interp [arg]` (git's hooks, a `./configure`) runs its interpreter when that is a wasm program, with the script's path as its argument, as execve does (`/bin/sh` is GNU bash), and the command policy sees the interpreter; anything else runs through the shell (`ctx.exec`, stdin read to the end first — none on a terminal, which never ends — output written when it finishes). Such a shell child learns which of its stdin / stdout is no terminal from `SLICC_STDIN_ISATTY=0` / `SLICC_STDOUT_ISATTY=0` in its environment (`stdio-tty.ts`; just-bash's `exec` carries nothing else), joins its parent's process group, and ends on any signal whose default action terminates, reported as WIFSIGNALED; stop and continue cannot pause it. An abort or the output limit ends the whole tree.
- **Across exec** (`process-fds.ts`, `describeInherited` in `process-fork.ts`): a child a program spawns or execs inherits every fd beyond 0-2 that is not close-on-exec, at the same number: pipes and sockets as the kernel descriptors they are (a socket keeps its O_NONBLOCK), a VFS file handed to the kernel first (as a fork does), while a device or a file of the program's own memory FS stays behind. `posix_spawn` file actions on those fds (close, dup2, open) apply. FD_CLOEXEC is per fd, on the stream (`sliccCloexec`): Emscripten keeps flags per open file description and ignores F_SETFD, so the runtime wraps the glue's fcntl, pipe2, dup3, socket and accept4 (found in its import object by identity, since names may be minified). O_CLOEXEC, F_SETFD, F_DUPFD_CLOEXEC and SOCK_CLOEXEC (`slicc_socket.c` passes it to the socket kernel's `socket` / `socketpair` / `accept`) set it, and a dup starts without it. A runner's private descriptor (GNU bash's state fd 97) starts close-on-exec. `open("/dev/fd/N")` (also `/proc/self/fd/N` and `/dev/stdin`, `/dev/stdout`, `/dev/stderr`) dups the process's own fd N, as on the BSDs (a file's offset is shared, where Linux would reopen it), and stat of one is fstat(N). `/dev/fd` links to `/proc/self/fd`, which lists as a directory of symlinks, and an inherited pipe fstats as a FIFO of its own, so `diff <(a) <(b)` sees two files. With bash configured for `/dev/fd` (`bash_cv_dev_fd=standard`), process substitution hands commands these paths. None of this touches the VFS; just-bash's `/dev/fd` (`approvals.md`) is a separate model.
- **fork** (`proc-fork`, `process-fork.ts`) starts a new worker for the child. The toolchain's fork library (`slicc-fork.js`, linked into bash) unwinds the parent's stack with Asyncify and hands over its linear memory, the Asyncify state and call-stack ids (as export names); the child's worker instantiates the same module, restores all of it (`sliccForkChild`) and resumes from `fork()` returning 0, while the parent resumes with the child's kernel pid at once. The kernel copies the parent's descriptor table (`FdTable.fork`), and before that the parent hands every VFS file it has open to the kernel as a shared description (`vfs-file.ts`: one buffer and offset, written back on the last close), so `{ a; b; } > out` keeps its order and a script bash reads is read on from where the parent stopped; devices reopen by path. Subshells, `&` jobs and pipeline stages therefore run concurrently even when they never exec (`(while :; do echo y; done) | head -1` ends). Where the kernel cannot fork, the in-process emulation runs instead, and there a child that execs ends at once with its pid standing for the program (`Module.sliccAliases`). The emulation's rewinds bypass Asyncify's `doRewind`, which pops the runtime keepalive a fork's unwind pushed; left pushed, `exit()` skips `exitRuntime` after the first fork — no atexit handlers (git waiting for its pager), no final stdio flush. `slicc-fork.js` pops it itself and says so (`SliccFork.balancesKeepalive`); for programs linked before that, the glue trailer pops it where the fork is taken.
- **Signals** (`signals.ts`, `process-signals.ts`): a program linked with the toolchain's `slicc_signals.c` reports which signals it catches or ignores whenever that changes (`sig-mask`), so the kernel applies SIGKILL and every default action itself — even to a busy program — and keeps a caught signal pending in a word of the SAB header. After each syscall the worker takes that word and runs the handlers through the program's `raise()`; a caught signal also interrupts a blocked pipe read or write or a `waitpid` with EINTR, which the runtime retries when every handler asked for SA_RESTART. `kill(2)` goes to the kernel (`proc-kill`): a process of the same `wasm` invocation gets any signal, one elsewhere in the process table the signals the table knows (INT, TERM, KILL, STOP, CONT), and `kill`/`ps` from the shell reach wasm processes the same way. A child's exit raises SIGCHLD in its parent. `execve` resets caught handlers and waits through `proc-exec`, during which signals sent to the process go to the program it exec'd, so `kill $!` of a background command ends the command itself. `proc-exec` releases the old image's descriptors first — the program holds its own copies of what it inherited — so a close-on-exec pipe reaches EOF at the exec: git's `start_command` reads such a pipe to learn that its child (a pager, a remote helper, `upload-pack`) exec'd, and waited for the child to end instead, deadlocking on it. Stop and continue are in **Job control** below.
- **select** (`select.ts`, `fd-select`): the toolchain's `pselect()` (`slicc_select.c`) hands a wait on kernel descriptors to the kernel, which returns when one is ready, the timeout passes, or a caught signal interrupts (EINTR) — how make's jobserver waits for a token or SIGCHLD, so `make -jN` runs N jobs at a time. Fds of the program's own FS fall back to Emscripten's non-blocking `select`. A signal already pending when a blocking call (pipe read/write that would block, `waitpid`, `select`) starts interrupts it at once, so a handler never waits behind a sleep that started just after the signal.
- **Terminal** (`tty.ts`, `wasm -t`): a program can lease the panel terminal. The session host (`SessionTerminal`) puts the panel in pty mode (`terminal-mode`), so keystrokes arrive raw (`terminal-stdin`), resizes as `terminal-resize`, and output streams; the kernel's `KernelTty` is the line discipline between them — canonical editing and echo, ^C/^\\/^Z as SIGINT/SIGQUIT/SIGTSTP to its foreground process group, ^D as end of file, raw mode, ONLCR, TIOCGWINSZ and SIGWINCH. The panel renders with Ghostty's VT core (`@wterm/ghostty`), so full-screen output (alternate screen, cursor addressing, colors) works; a `TERM` that is unset or `dumb` reaches the program as `xterm-256color` with `COLORTERM=truecolor`. `/dev/tty` opens the process's controlling terminal (`fd-open-tty`): its session's, the terminal the session's leader started on (`JobTable`), so a pager reads its keys there whatever its stdio is (`git log` pages through less, which searches and quits on `q`); a session without one (the agent's `bash` tool, or after `setsid`) gets ENXIO. Another terminal device it opens (the `/dev/tty1` that `ttyname()` names) is the kernel terminal its stdio is on; either keeps the access mode asked for. With GNU bash installed, the panel's session starts with `wasm --login` (`bash --rcfile /dev/fd/98 -i` on its terminal, `RemoteTerminalView.startSession`, output streamed and not retained). Its rc comes on a private close-on-exec descriptor and reads `~/.bashrc`. It exists for its command before the first prompt: without one, bash saves PIPESTATUS around the first `PROMPT_COMMAND` before the array exists, and restoring that leaves PIPESTATUS empty for the whole session (an upstream bash bug) and falls back to the slicc prompt when bash exits. "Run in terminal" types into bash meanwhile and returns the command's output and status: the login shell's `PROMPT_COMMAND` marks each prompt with `$?` (a private OSC the view strips, `login-shell-marks.ts`). A picker requested without a user gesture opens from `<slicc-permissions>`'s Allow button instead: the device choosers (`usb-request`, `hid-request`, `serial-request` panel-RPC, which `esptool` without `--port` uses too) and the display picker (`screencapture`, whose session `computer add screen` starts) through `ui/panel-rpc/gesture-picker.ts`, and `mount`'s directory picker through `permission-request` (kind `filesystem`, `fs/mount/local-mount-acquire.ts`). A cone tool call keeps its chat approval card. fds 0-2 share one TTY description; the runtime marks only real terminals as such (`fd-info`), so `isatty` is false for pipes and files, and backs Emscripten's termios ioctls with `tty-get`/`tty-set`/`tty-winsz`. A process a signal ended is reported to its parent as WIFSIGNALED (and a process that exec'd one ends by the same signal), so an interactive bash abandons a command list on ^C as it does on Linux.
- **GNU bash as the agent's shell** (`shell/gnu-bash.ts`): with a package providing `bash` installed, `AlmostBashShellHeadless` built with `gnuBash` (the agent's shells) runs each command as `bash -c` through `runWasmCommand`, streaming output to the run's tee. A one-line hook on the command's first line sets an EXIT trap that writes the status, PIPESTATUS, `$PWD` and exported variables to fd 97, a private sink only the runner holds (the program starts with it: `WasmProcessInitMsg.fds`, `wireKernelFd`), and the shell takes that state on; a run that leaves none (`exec`, a replaced trap, a kill) keeps the previous state. Nothing goes through the filesystem: `$TMPDIR` is under `/tmp`, which every scoop can write, so a hook or state file there could be swapped to run code or inject a PATH with another unit's authority. The command policy follows every program bash runs: `WasmSession` asks the shell's `NativeGate` (its command list and sudo `Cmnd` rules) before a program runs natively, and a denied one reports the denial and exits with its code; commands that run through just-bash meet its dispatch gate as before. A shell restricted to a command list runs on GNU bash as well; bash's builtins are always available there. Bash's builtins run inside bash and meet no command gate — except that `kill` of a process outside the invocation (the process table's) asks the gate as `kill -SIG PID` would, and is EPERM when denied.
- **Job control** (`jobs.ts`): each `wasm` invocation keeps a `JobTable` of process groups and sessions. Its first process leads a session and group, and a child starts in its parent's. `setpgid`/`getpgid`/`getsid`/`setsid` (`proc-setpgid` …) and `tcgetpgrp`/`tcsetpgrp` on a terminal (`tty-pgrp-get`/`tty-pgrp-set`) follow POSIX's rules (same-session groups only, a session leader stays put), `kill(0)` and `kill(-pgid)` signal a group, and the terminal's signals go to its foreground group. A stop signal's default action (SIGSTOP always; SIGTSTP/SIGTTIN/SIGTTOU when not caught) stops the process: its syscalls — and the answer to one in flight — wait for SIGCONT, and a blocked call is interrupted and runs again once continued, so a stopped process takes no terminal input. A parent hears of stops and continues through `waitpid(WUNTRACED|WCONTINUED)` and SIGCHLD; a process that exec'd a program stops and continues with it, and a group signal reaches that program once, through its exec parent. A background group reading the terminal gets SIGTTIN (EIO when it ignores it). The toolchain's `slicc_jobs.c` overrides Emscripten's single-process stubs. With it, `wasm -t bash` has job control: ^Z, `jobs`, `fg`, `bg`, `&`, `kill %1`. A process is stopped at its next syscall, not mid-computation.
- **Programs** are Emscripten glue linked with `-sENVIRONMENT` including `worker`; the kernel compiles the module (cached per path, size and mtime). They come from ipk-installed packages, never a host mount: `shell/ipk/wasm-programs.ts` reads each global package's `slicc.commands` manifest (or the `bin/<x>` + `bin/<x>.wasm` pairs of an `@ai-ecoverse/wasm-*` package), `ScriptCatalog.getWasmCommands` caches the set, and the shell registers each name with the late-binding script handler (built-in > `.jsh` > wasm program > workflow). Syscalls block in `Atomics.wait`, so the realm needs `SharedArrayBuffer` (a cross-origin-isolated leader); without it `wasm` says so and exits 126. In the extension float the kernel runs in the hosted leader tab under ordinary web CSP, like `node -e`.

## Wiring map

`createKernelHost` builds the manager and threads it explicitly through:

```
createKernelHost
  ├── ProcessManager
  │     └── publishes globalThis.__slicc_pm fallback for shell-script callers
  ├── Orchestrator.setProcessManager(pm)
  │     └── ScoopContext (constructor 7th arg)
  │           └── adaptTools({ processManager, owner, getParentPid })
  └── createPanelTerminalHost({ processManager, fs, browser, transport })
        └── TerminalSessionHost({ processManager, … })
              └── AlmostBashShellHeadless({ processManager, processOwner, getCurrentShellPid? })
                    └── jsh-executor (executeJshFile / executeJsCode)
```

The `globalThis.__slicc_pm` fallback exists for `.jsh` scripts and any code path that can't accept constructor injection. `ps` and `kill` prefer the DI path through `createSupplementalCommands` but fall through to the global as a backup.

`createPanelTerminalHost` is the single source of truth for the panel-terminal wiring: the standalone DedicatedWorker (`kernel-worker.ts`) and the thin-bridge extension (via the hosted leader tab's kernel worker) both call it, so panel-typed `ps` / `kill` / `cat /proc/<pid>/...` work uniformly across floats. Tests live at `tests/kernel/panel-terminal-host.test.ts`.
