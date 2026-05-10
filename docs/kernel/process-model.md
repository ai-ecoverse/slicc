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
  readonly kind: ProcessKind; // 'scoop-turn' | 'tool' | 'shell' | 'jsh' | 'py' | 'net'
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly owner: ProcessOwner; // { kind: 'cone' | 'scoop' | 'system', scoopJid? }
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

## Where pids come from

| Kind         | Spawn site                                          | argv                                    |
| ------------ | --------------------------------------------------- | --------------------------------------- |
| `scoop-turn` | `ScoopContext.prompt()`                             | `['prompt', <truncated user text>]`     |
| `tool`       | `tool-adapter.ts adaptTool()`                       | `[tool.name, <principal string param>]` |
| `shell`      | `TerminalSessionHost.handleExec()` (panel terminal) | `[command-line]`                        |
| `jsh`        | `executeJshFile` / `executeJsCode` (via realm)      | `['node', scriptPath, …args]`           |
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

First-wins applies only to `SIGINT` / `SIGTERM`. `SIGKILL` is uncatchable: it always overwrites `terminatedBy`, mirroring POSIX. The realm runner (`kind:'jsh'` and `kind:'py'`) is the only path with a hard-stop guarantee on SIGKILL today.

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
```

Deliberate omissions: no `/proc/self` (would require `currentPid()` tracking which we don't do), no `environ` (would leak masked secrets), no `fd/` or `task/`. The full Linux procfs surface is out of scope; just what `ps` and `kill` need to drive their views.

## `ps` and `kill`

`ps` (default) lists `running` and `pending` processes only. `-a` / `-A` / `-e` / `--all` includes the dead. Tree mode (`-T`) walks `ppid` links and indents children with `└─`.

`kill` defaults to SIGTERM (POSIX). Short forms: `-INT`, `-TERM`, `-KILL`, `-STOP`, `-CONT`, `-9`. Long form: `-s SIGINT`. Multiple pids in one call. Exit codes: 0 if every signal landed; 1 if any pid was unknown / already terminated; 2 on parse error.

## Realm runner

`runInRealm(opts)` spawns a per-task realm — a `DedicatedWorker` (standalone JS, both-mode Python) or a per-task sandbox iframe (extension JS) — and registers a `kind:'jsh'` (for `kind:'js'`) or `kind:'py'` process. The runner subscribes to `pm.onSignal`; on SIGKILL it calls `realm.terminate()` (`worker.terminate()` / `iframe.remove()`, both uncatchable) and exits 137. For SIGINT/SIGTERM, the runner records the state but does NOT terminate — the running script is opaque from this side; cooperative cancel of an arbitrary tool's awaits isn't possible without threading abort signals through every layer.

The user-facing surface is the `node` (`-e`/`script.js`/stdin), `.jsh` discovery, and `python`/`python3` (`-c`/`script.py`/stdin) commands. Realm code runs inside an `AsyncFunction` (JS) or Pyodide (Python) with shimmed `console`, `process.argv`/`sys.argv`, `process.env`, `process.stdout`/`process.stderr`, `process.exit(N)` / Python `SystemExit`. The realm-host on the kernel side proxies `vfs` (read/write/list/etc.), `exec` (just-bash subcommand), and `fetch` (SecureFetch with secret substitution) over the realm's port, so realm scripts get a full Node-like surface without holding kernel-side state.

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
              └── WasmShellHeadless({ processManager, processOwner, getCurrentShellPid? })
                    └── jsh-executor (executeJshFile / executeJsCode)
```

The `globalThis.__slicc_pm` fallback exists for `.jsh` scripts and any code path that can't accept constructor injection. `ps` and `kill` prefer the DI path through `createSupplementalCommands` but fall through to the global as a backup.

`createPanelTerminalHost` is the single source of truth for the panel-terminal wiring: both the standalone DedicatedWorker (`kernel-worker.ts`) and the extension offscreen document (`packages/chrome-extension/src/offscreen.ts`) call it, so panel-typed `ps` / `kill` / `cat /proc/<pid>/...` work uniformly across floats. Tests live at `tests/kernel/panel-terminal-host.test.ts`.
