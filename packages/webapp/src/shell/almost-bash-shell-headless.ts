/**
 * `AlmostBashShellHeadless` — the worker-safe shell base class.
 *
 * The agent's `bash` tool calls run here. Owns just-bash,
 * the VFS adapter, custom commands (git, mount, supplemental), the
 * `.jsh` discovery + sync loop, and the `executeCommand` /
 * `executeScriptFile` primitives. Zero DOM in this class's own code
 * (`setInterval`, `IndexedDB`-backed VFS only). Shell-command
 * telemetry is emitted through the dependency-inverted
 * `telemetry-hook.ts` sink (the UI registers `trackShellCommand`)
 * rather than importing `ui/telemetry.ts` directly, so the shell no
 * longer carries a back-edge into the `ui/` layer. The file still
 * lives outside `tsconfig.webapp-worker.json`'s no-DOM include
 * because its remaining (type-only) `cdp/` imports transitively reach
 * the DOM-bound CDP transports.
 *
 * The view layer — `AlmostBashShell` in `almost-bash-shell.ts` — extends this
 * class and adds xterm mounting, the line editor, history, and
 * media-preview rendering. Worker-resident shells construct
 * `AlmostBashShellHeadless` directly (or — equivalently for now —
 * `AlmostBashShell`, which inherits the headless behavior and only
 * activates view code on `mount()`).
 *
 * `renderMediaPreview` is a `protected` extension point: the
 * headless implementation throws "preview unavailable in headless
 * mode" because there's no DOM to draw into; `AlmostBashShell` overrides
 * with the existing image/video preview logic. The terminal
 * RPC will replace the throw with a `terminal-media-preview`
 * envelope emit.
 */

import type { BashExecResult, Command, CommandContext, CommandName, ExecResult } from 'just-bash';
import { Bash, defineCommand, getCommandNames, getNetworkCommandNames } from 'just-bash';
import type { BrowserAPI } from '../cdp/index.js';
import type { FsWatcher, VirtualFS } from '../fs/index.js';
import { MountCommands } from '../fs/mount-commands.js';
import { GitCommands } from '../git/git-commands.js';
import type { ProcessManager, ProcessOwner } from '../kernel/process-manager.js';
import type { SudoBroker } from '../sudo/types.js';
import type { BshDiscoveryFS } from './bsh-discovery.js';
import type { JshDiscoveryFS } from './jsh-discovery.js';
import type { JshProcessConfig } from './jsh-executor.js';
import { executeJsCode, executeJshFile } from './jsh-executor.js';
import { EMPTY_BYTES } from './just-bash-compat.js';
import { parseShellArgs } from './parse-shell-args.js';
import { createProxiedFetch } from './proxied-fetch.js';
import { ScriptCatalog } from './script-catalog.js';
import { enforceCommandSudo } from './sudo/command-guard.js';
import { SUDOERS_D_DIR, type SudoersPolicy, sanitizeGrantPattern } from './sudo/sudoers.js';
import {
  createSkillCommand,
  createUpskillCommand,
} from './supplemental-commands/upskill-command.js';
import type { MediaPreviewItem } from './supplemental-commands.js';
import { createSupplementalCommands } from './supplemental-commands.js';
import { emitShellCommand } from './telemetry-hook.js';
import { VfsAdapter } from './vfs-adapter.js';
import { buildWorkflowRunArgv, type WorkflowCommandEntry } from './workflow-discovery.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Worker-safe slice of `AlmostBashShellOptions` (no DOM `container`). */
export interface HeadlessShellOptions {
  fs: VirtualFS;
  /** Initial working directory. Default: / */
  cwd?: string;
  /** Initial environment variables. */
  env?: Record<string, string>;
  /** BrowserAPI for the `playwright-cli` / `serve` / `open` commands. */
  browserAPI?: BrowserAPI;
  /**
   * FS to use for `.jsh` discovery. Defaults to `fs`. Useful for
   * scoops where skill loading needs the unrestricted VFS but the
   * shell uses a `RestrictedFS`.
   */
  jshDiscoveryFs?: JshDiscoveryFS;
  /** FS to use for `.bsh` discovery. Defaults to `fs`. */
  bshDiscoveryFs?: BshDiscoveryFS;
  /** Optional shared script catalog. When omitted, the shell creates one. */
  scriptCatalog?: ScriptCatalog;
  /** Optional command allow-list. `'*'` means unrestricted (the default). */
  allowedCommands?: readonly string[];
  /** JID of the parent scoop, when this shell runs inside a scoop. */
  getParentJid?: () => string | undefined;
  /** True if owned by a non-interactive scoop (gates the `mount` picker). */
  isScoop?: () => boolean;
  /**
   * Process manager for `kind:'jsh'` registration. When omitted,
   * the shell falls back to behavior with no `.jsh` script
   * visibility in `ps`. When supplied alongside `processOwner`,
   * every `executeScriptFile` and `node -e` call registers a
   * process record under the active shell's pid (when
   * `getCurrentShellPid` is also supplied) or as an orphan
   * (`ppid: 1`) otherwise.
   */
  processManager?: ProcessManager;
  /** Default owner for spawned `kind:'jsh'` processes. */
  processOwner?: ProcessOwner;
  /**
   * Returns the active `kind:'shell'` pid the jsh script runs
   * under (e.g. the bash command the user typed that resolved
   * to `myscript.jsh`). When omitted, jsh processes get
   * `ppid: 1` (kernel-host anchor) — `ps -T` will still
   * show them but as orphans.
   */
  getCurrentShellPid?: () => number | undefined;
  /**
   * Optional command-level sudo enforcement. When omitted (or when
   * `getPolicy()` returns `null`), commands run ungated with zero added
   * prompts. Wired by the kernel host / orchestrator once the sudoers policy
   * and broker are available.
   */
  sudo?: ShellSudoConfig;
}

/** Command-level sudo enforcement hooks supplied to the shell. */
export interface ShellSudoConfig {
  /** Returns the current (live-reloadable) policy, or `null` to disable gating. */
  getPolicy: () => SudoersPolicy | null;
  /** Trusted-realm approval broker (the agent can only request, never fabricate). */
  broker: SudoBroker;
  /**
   * Optional sink that persists a human-confirmed `NOPASSWD Cmnd` grant. When
   * supplied, the shell routes "Always" grants here instead of writing through
   * `options.fs` directly — this lets the shell run on the FS-gated handle (so
   * the `/etc/sudoers` self-protection invariant covers shell writes too) while
   * the grant append still hits the raw VFS and does not re-prompt.
   */
  persistCommandGrant?: (pattern: string) => Promise<void>;
  /**
   * Whether to wrap every dispatched command with the transparent `Cmnd` gate.
   * Defaults to `true` (the agent-shell behavior: any policy-gated command
   * prompts on dispatch). Set to `false` for the human terminal — the explicit
   * `sudo <cmd...>` command is still registered (and still gathers approval
   * + persists "Always" grants), but plain commands run ungated. The human
   * typing into the panel IS the approver for everything they type.
   */
  transparentGating?: boolean;
}

// ---------------------------------------------------------------------------
// Headless surface (interface)
// ---------------------------------------------------------------------------

/**
 * The shell methods the kernel worker (and any future
 * terminal-view-driven RPC client) needs. `AlmostBashShell` and
 * `AlmostBashShellHeadless` both satisfy this.
 */
export interface HeadlessShellLike {
  getBash(): Bash;
  getCwd(): string;
  getScriptCatalog(): ScriptCatalog;
  getEnv(): Record<string, string>;
  getJshCommandNames(): Promise<string[]>;
  syncJshCommands(): Promise<void>;
  executeCommand(
    command: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  executeScriptFile(
    scriptPath: string,
    args?: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export type { BashExecResult };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WatcherAwareFs {
  getWatcher?(): FsWatcher | null;
}
interface UnderlyingFsProvider {
  getUnderlyingFS?(): unknown;
}

function getFsWatcher(fs: unknown): FsWatcher | null {
  if (fs && typeof (fs as WatcherAwareFs).getWatcher === 'function') {
    return (fs as WatcherAwareFs).getWatcher?.() ?? null;
  }
  if (fs && typeof (fs as UnderlyingFsProvider).getUnderlyingFS === 'function') {
    return getFsWatcher((fs as UnderlyingFsProvider).getUnderlyingFS?.());
  }
  return null;
}

type BashExecOptionsWithSignal = NonNullable<Parameters<Bash['exec']>[1]> & {
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class AlmostBashShellHeadless implements HeadlessShellLike {
  protected bash: Bash;
  protected vfsAdapter: VfsAdapter;
  protected gitCommands: GitCommands;
  protected mountCommands: MountCommands;
  /** Accumulated env state from successive exec() calls. */
  protected lastEnv: Record<string, string>;
  protected cwd: string;
  /** Set of all built-in + custom command names (for shadowing protection). */
  protected builtinCommandNames: Set<string>;
  /** Built-in/custom command names captured BEFORE any .jsh/workflow registration. */
  protected readonly staticBuiltinNames: Set<string>;
  /**
   * Allow-list of command names. `null` means unrestricted — every command is
   * permitted. Otherwise only names in the set may be registered or executed.
   */
  protected readonly allowedCommands: ReadonlySet<string> | null;
  protected readonly scriptCatalog: ScriptCatalog;
  protected readonly ownsScriptCatalog: boolean;
  /** Maps .jsh command names to their registered script paths. */
  protected registeredJshCommands = new Map<string, string>();
  /** Workflow command names we've registered (handler is dynamic, so a Set suffices). */
  protected registeredWorkflowCommands = new Set<string>();
  /** Promise for the currently in-flight jsh sync. */
  private jshSyncInflight: Promise<void> | null = null;
  /** Re-sync requested while one was already in flight. */
  private jshSyncDirty = false;
  /**
   * "Always" command grants confirmed mid-dispatch, queued for persistence
   * after the current `bash.exec()` returns. The grant write touches the
   * IndexedDB-backed VFS, whose async timers are blocked by just-bash's
   * defense-in-depth during command execution, so it must run outside the box.
   */
  private pendingCommandGrants: string[] = [];
  /**
   * One-shot bypass keys for the transparent `Cmnd` gate. Registered by the
   * explicit `sudo` command after the human already approved a subject, so the
   * inner dispatch does not prompt a second time. Multiset (counts) because
   * the same subject can be re-approved repeatedly within a single bash exec.
   */
  private pendingSudoBypasses = new Map<string, number>();
  /**
   * Env writes performed by supplemental commands during a `bash.exec()` call
   * (currently only `secret set` injecting a masked value). `bash.exec()`
   * returns its own snapshot of the working env that overwrites `lastEnv` on
   * return — these pending writes are reapplied after that overwrite so they
   * survive into the next exec call.
   */
  private pendingEnvWrites = new Map<string, string>();

  constructor(protected options: HeadlessShellOptions) {
    this.vfsAdapter = new VfsAdapter(options.fs);
    this.allowedCommands =
      options.allowedCommands && !options.allowedCommands.includes('*')
        ? new Set(options.allowedCommands)
        : null;
    const initialCwd = options.cwd ?? '/';
    const initialEnv: Record<string, string> = {
      HOME: '/',
      PATH: '/usr/bin',
      USER: 'user',
      SHELL: '/bin/bash',
      PWD: initialCwd,
      ...options.env,
    };

    this.gitCommands = new GitCommands({
      fs: options.fs,
      authorName: initialEnv.GIT_AUTHOR_NAME ?? 'User',
      authorEmail: initialEnv.GIT_AUTHOR_EMAIL ?? 'user@example.com',
    });

    this.mountCommands = new MountCommands({ fs: options.fs, isScoop: options.isScoop });

    const scriptDiscoveryFs = options.jshDiscoveryFs ?? options.fs;
    const bshDiscoveryFs = options.bshDiscoveryFs ?? options.fs;
    const scriptWatcher = getFsWatcher(scriptDiscoveryFs) ?? getFsWatcher(bshDiscoveryFs);
    this.scriptCatalog =
      options.scriptCatalog ??
      new ScriptCatalog({
        jshFs: scriptDiscoveryFs,
        bshFs: bshDiscoveryFs,
        watcher: scriptWatcher,
      });
    this.ownsScriptCatalog = !options.scriptCatalog;

    if (scriptWatcher) {
      scriptWatcher.watch(
        '/',
        (path) => path.endsWith('.jsh') || path.endsWith('.workflow.js'),
        () => {
          void this.syncJshCommands().catch(() => undefined);
        }
      );
    }

    const gitCommand = this.createGitCustomCommand();
    const supplementalCommands = createSupplementalCommands({
      onMediaPreview: async (items) => this.renderMediaPreview(items),
      getJshCommands: () => this.getJshCommandNames(),
      getWorkflowCommands: () => this.getWorkflowCommandNames(),
      syncScriptCommands: () => this.syncJshCommands(),
      getStaticBuiltins: () => [...this.staticBuiltinNames],
      fs: options.fs,
      scriptCatalog: this.scriptCatalog,
      browserAPI: options.browserAPI,
      getParentJid: options.getParentJid,
      // Thread the manager into `ps` / `kill`. When the
      // shell is constructed without one (extension offscreen,
      // inline standalone), the commands fall back to
      // `globalThis.__slicc_pm` (published by `createKernelHost`).
      processManager: options.processManager,
      // Explicit `sudo <cmd...>` plumbing. Only wired when a sudo config is
      // present so ungated shells still register `sudo` (which prints a clean
      // "not configured" message) without leaking the broker or bypass hook.
      sudoCommand: options.sudo
        ? {
            broker: options.sudo.broker,
            // Queue "Always" grants for the post-exec flush; the actual VFS
            // write must run outside just-bash's defense-in-depth box where
            // async timers are blocked. Matches the transparent gate.
            persistGrant: async (pattern) => {
              this.pendingCommandGrants.push(pattern);
            },
            suppressNextGate: (subject) => this.registerSudoBypass(subject),
          }
        : undefined,
      // Lets `secret set` write the masked value into the owning shell's
      // env after a successful set (parity with container-loaded secrets).
      // The write is queued and reapplied after `bash.exec` returns its
      // snapshot of `result.env`, so the var survives into the next exec.
      setEnv: (name, value) => {
        this.pendingEnvWrites.set(name, value);
        this.lastEnv[name] = value;
      },
    });
    const mountCommand = this.createMountCustomCommand();
    const fetchFn = createProxiedFetch();

    const allCustomCommands = [
      gitCommand,
      mountCommand,
      createSkillCommand(options.fs),
      createUpskillCommand(options.fs, fetchFn, options.browserAPI),
      ...supplementalCommands,
    ];
    const customCommands = allCustomCommands.filter((c) => this.isCommandAllowed(c.name));

    const allBuiltinNames = [
      ...getCommandNames(),
      ...getNetworkCommandNames(),
    ] as readonly CommandName[];
    const allowedBuiltinNames: CommandName[] | undefined = this.allowedCommands
      ? allBuiltinNames.filter((n) => this.isCommandAllowed(n))
      : undefined;

    this.bash = new Bash({
      fs: this.vfsAdapter,
      cwd: initialCwd,
      env: initialEnv,
      fetch: fetchFn,
      commands: allowedBuiltinNames,
      customCommands,
    });

    // Network-command post-registration cleanup (Codex P1 on #433).
    //
    // just-bash's `BashOptions.commands` filter controls only the
    // non-network built-ins. When `fetch` (or `network`) is set,
    // just-bash unconditionally registers EVERY name from
    // `getNetworkCommandNames()` regardless of `commands`. We always
    // pass `fetch` (via `createProxiedFetch()`), so without this
    // cleanup a scoop with `allowedCommands: ['echo']` could still
    // execute `curl`, `wget`, etc. — defeating the per-scoop
    // isolation guarantee.
    //
    // Delete the disallowed network commands from the already-populated
    // registry. Reaches into `Bash`'s private `commands: Map` via cast.
    if (this.allowedCommands !== null) {
      const bashInternals = this.bash as unknown as { commands: Map<string, unknown> };
      for (const name of getNetworkCommandNames()) {
        if (!this.isCommandAllowed(name)) {
          bashInternals.commands.delete(name);
        }
      }
    }

    // Command-level sudo enforcement (dispatch-time chokepoint). Decorate every
    // already-registered command's `execute` so the `Cmnd` policy is checked at
    // actual dispatch — this covers `$(...)`/backticks/pipelines for free since
    // just-bash routes those back through this same registry. Only wrap when a
    // sudo config is present AND transparent gating is enabled — the human
    // terminal opts out via `transparentGating: false` so plain commands run
    // ungated even though `sudo <cmd...>` is still available. Newly-registered
    // `.jsh` commands are wrapped in `doSyncJshCommands` via the same chokepoint.
    if (this.isTransparentGatingEnabled()) {
      const registry = this.bash as unknown as { commands: Map<string, Command> };
      for (const [name, cmd] of registry.commands) {
        registry.commands.set(name, this.wrapCommandForSudo(cmd));
      }
    }

    const customCommandNames = customCommands.map((c) => c.name);
    const registeredBuiltinNames = allowedBuiltinNames ?? [
      ...getCommandNames(),
      ...getNetworkCommandNames(),
    ];
    this.builtinCommandNames = new Set([...registeredBuiltinNames, ...customCommandNames]);
    this.staticBuiltinNames = new Set(this.builtinCommandNames); // snapshot before scripts
    this.vfsAdapter.setRegisteredCommandsFn(() => [...this.builtinCommandNames]);

    this.lastEnv = { ...initialEnv };
    this.cwd = initialCwd;

    // Kick off initial .jsh registration (async, non-blocking).
    void this.syncJshCommands().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** The underlying just-bash instance. */
  getBash(): Bash {
    return this.bash;
  }

  /** Current working directory. */
  getCwd(): string {
    return this.cwd;
  }

  /** Shared `.jsh`/`.bsh` discovery catalog. */
  getScriptCatalog(): ScriptCatalog {
    return this.scriptCatalog;
  }

  /** A copy of the latest environment. */
  getEnv(): Record<string, string> {
    return { ...this.lastEnv };
  }

  /** Currently discovered `.jsh` command names (filtered by allow-list). */
  async getJshCommandNames(): Promise<string[]> {
    return [...(await this.getFilteredJshCommands()).keys()];
  }

  /**
   * Discover `.jsh` commands and register any new ones as just-bash
   * custom commands. Idempotent; in-flight calls coalesce.
   */
  async syncJshCommands(): Promise<void> {
    if (this.jshSyncInflight) {
      this.jshSyncDirty = true;
      return this.jshSyncInflight;
    }
    this.jshSyncInflight = this.doSyncJshCommands();
    return this.jshSyncInflight;
  }

  /** One-shot non-streaming command execution. */
  async executeCommand(
    command: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.runCommand(command, signal);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /** Execute a `.jsh`/`.bsh` script file by VFS path. */
  async executeScriptFile(
    scriptPath: string,
    args: string[] = []
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return executeJshFile(
      scriptPath,
      args,
      {
        fs: this.vfsAdapter,
        cwd: this.cwd,
        env: new Map(Object.entries(this.lastEnv)),
        stdin: EMPTY_BYTES,
        exec: (cmd, opts) => this.bash.exec(cmd, { env: this.lastEnv, cwd: opts?.cwd ?? this.cwd }),
      },
      this.buildJshProcessConfig()
    );
  }

  /**
   * Tear down. Disposes the script catalog if owned. Subclasses
   * (the view layer) override and call `super.dispose()`.
   */
  dispose(): void {
    if (this.ownsScriptCatalog) {
      this.scriptCatalog.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Subclass hooks
  // -------------------------------------------------------------------------

  /**
   * Render an inline media preview (e.g. for `imgcat`). Headless
   * default throws because there's no DOM to draw into. The
   * `AlmostBashShell` view subclass overrides with the existing
   * image/video preview rendering. The terminal RPC will add
   * a third implementation that emits a `terminal-media-preview`
   * envelope over the kernel transport.
   */
  protected async renderMediaPreview(_items: MediaPreviewItem[]): Promise<void> {
    throw new Error('terminal preview is unavailable in headless mode');
  }

  /**
   * Run a command through just-bash, carrying forward env/cwd state.
   * Subclasses (the view layer) call this from
   * `executeCommandInTerminal` to share state.
   */
  protected async runCommand(command: string, signal?: AbortSignal): Promise<BashExecResult> {
    const commandName = command.trim().split(/\s+/)[0] || 'unknown';
    emitShellCommand(commandName);

    // just-bash's published ExecOptions type does not yet expose
    // AbortSignal, but we still forward it so external callers and
    // terminal Ctrl+C keep a consistent cancellation path.
    const execOptions: BashExecOptionsWithSignal = {
      env: this.lastEnv,
      cwd: this.cwd,
      signal,
    };
    const result = await this.bash.exec(command, execOptions);
    // Persist any "Always" command grants confirmed during dispatch now that we
    // are outside just-bash's execution box (where VFS async timers are blocked).
    await this.flushPendingCommandGrants();
    if (result.env) {
      this.lastEnv = { ...result.env };
    }
    // Reapply env writes performed by supplemental commands during this exec
    // (e.g. `secret set` injecting a masked value). `bash.exec`'s `result.env`
    // does not include them — without this re-merge the next exec would not see
    // `$NAME`.
    if (this.pendingEnvWrites.size > 0) {
      for (const [k, v] of this.pendingEnvWrites) {
        this.lastEnv[k] = v;
      }
      this.pendingEnvWrites.clear();
    }
    if (result.env?.PWD) {
      this.cwd = result.env.PWD;
    }

    if (result.exitCode === 127) {
      const jshResult = await this.tryJshFallback(command);
      if (jshResult) {
        void this.syncJshCommands().catch(() => undefined);
        return jshResult;
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * True when the dispatch-time transparent `Cmnd` gate should wrap every
   * command. Requires a sudo config AND `transparentGating !== false` —
   * defaults to enabled (agent-shell behavior) when the flag is omitted.
   */
  private isTransparentGatingEnabled(): boolean {
    const sudo = this.options.sudo;
    return !!sudo && sudo.transparentGating !== false;
  }

  /**
   * Decorate a command's `execute` with the dispatch-time sudo guard. When no
   * sudo config is present, or `transparentGating` is explicitly false (the
   * human terminal), the command is returned unchanged (zero overhead).
   * Otherwise the wrapper runs the `Cmnd` check against the
   * already-tokenized `name + args` subject before delegating to the wrapped
   * `execute`, returning an exit-1 result (without running it) on denial.
   */
  private wrapCommandForSudo(command: Command): Command {
    if (!this.isTransparentGatingEnabled()) return command;
    const guard = (args: string[]) => this.gateCommandDispatch(command.name, args);
    return {
      name: command.name,
      trusted: command.trusted,
      async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
        const denial = await guard(args);
        if (denial) return denial;
        return command.execute(args, ctx);
      },
    };
  }

  /**
   * Run the command-level sudo guard for a single dispatch. Returns a denial
   * `ExecResult` (exit 1, no execution) when approval was refused; `null` when
   * the command may run. No-op when sudo is unconfigured or the active policy
   * is null.
   */
  private async gateCommandDispatch(name: string, args: string[]): Promise<ExecResult | null> {
    const sudo = this.options.sudo;
    if (!sudo) return null;

    const subject = `${name} ${args.join(' ')}`.trim();

    // Consume a one-shot bypass when the explicit `sudo` command already
    // collected approval for this exact subject. Skips even the policy lookup
    // so a separately-dispatched gated nested command (via $() / pipelines)
    // still hits the transparent gate normally.
    if (this.consumeSudoBypass(subject)) {
      return null;
    }

    const policy = sudo.getPolicy();
    if (!policy) return null;

    const result = await enforceCommandSudo(subject, {
      policy,
      broker: sudo.broker,
      // Queue the grant; the actual write runs post-exec (see runCommand)
      // because just-bash blocks the VFS's async timers mid-dispatch.
      persistGrant: async (pattern) => {
        this.pendingCommandGrants.push(pattern);
      },
    });
    if (result.allowed) return null;

    return {
      stdout: '',
      stderr: `${result.message}\n`,
      exitCode: 1,
    };
  }

  /**
   * Register a one-shot bypass for the next transparent `Cmnd` gate dispatch
   * matching `subject`. Invoked by the explicit `sudo` command after it has
   * already collected human approval, so the inner command does not prompt
   * twice. Multiple registrations for the same subject stack (multiset).
   */
  private registerSudoBypass(subject: string): void {
    const key = subject.trim();
    if (!key) return;
    this.pendingSudoBypasses.set(key, (this.pendingSudoBypasses.get(key) ?? 0) + 1);
  }

  /**
   * Consume a pending bypass for `subject`. Returns `true` when a bypass was
   * pending (and was decremented), `false` otherwise.
   */
  private consumeSudoBypass(subject: string): boolean {
    const count = this.pendingSudoBypasses.get(subject);
    if (!count) return false;
    if (count === 1) {
      this.pendingSudoBypasses.delete(subject);
    } else {
      this.pendingSudoBypasses.set(subject, count - 1);
    }
    return true;
  }

  /**
   * Drain {@link pendingCommandGrants}, persisting each confirmed "Always"
   * grant. Called from `runCommand` after `bash.exec()` returns, so the writes
   * happen outside just-bash's timer-blocked execution box. Failures are
   * swallowed per-grant so a persistence error never fails the command the user
   * already approved.
   */
  private async flushPendingCommandGrants(): Promise<void> {
    if (this.pendingCommandGrants.length === 0) return;
    const grants = this.pendingCommandGrants;
    this.pendingCommandGrants = [];
    for (const pattern of grants) {
      try {
        await this.persistCommandGrant(pattern);
      } catch {
        /* best-effort: a failed grant write must not fail an approved command */
      }
    }
  }

  /**
   * Append a human-confirmed `NOPASSWD Cmnd` grant to `/etc/sudoers.d/granted`.
   * Prefers the injected `persistCommandGrant` sink (which writes through the
   * raw VFS, so the self-protection invariant does not re-prompt on the grant
   * write); falls back to `options.fs` directly when no sink is supplied.
   */
  private async persistCommandGrant(pattern: string): Promise<void> {
    const sink = this.options.sudo?.persistCommandGrant;
    if (sink) {
      await sink(pattern);
      return;
    }
    const safe = sanitizeGrantPattern(pattern);
    if (!safe) return;
    const path = `${SUDOERS_D_DIR}/granted`;
    const fs = this.options.fs;
    let existing = '';
    try {
      if (await fs.exists(path)) {
        existing = (await fs.readFile(path)) as string;
      }
    } catch {
      existing = '';
    }
    const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
    await fs.writeFile(path, `${prefix}NOPASSWD Cmnd  ${safe}\n`);
  }

  /** True when `name` is registrable/executable under the allow-list. */
  private isCommandAllowed(name: string): boolean {
    return this.allowedCommands === null || this.allowedCommands.has(name);
  }

  private async doSyncJshCommands(): Promise<void> {
    try {
      const jshMap = await this.scriptCatalog.getJshCommands();
      const wfMap = await this.getFilteredWorkflowCommands();

      // .jsh names: keep the existing path-keyed registry + guard.
      for (const [name, scriptPath] of jshMap) {
        if (!this.isCommandAllowed(name)) continue;
        if (this.builtinCommandNames.has(name) && !this.registeredJshCommands.has(name)) continue;
        if (this.registeredJshCommands.get(name) === scriptPath) continue;
        this.bash.registerCommand(this.wrapCommandForSudo(this.makeScriptCommand(name)));
        this.registeredJshCommands.set(name, scriptPath);
        this.builtinCommandNames.add(name);
      }

      // Workflow names: register the SAME unified handler ONCE per name (it resolves
      // .jsh-vs-workflow at dispatch, so the order between the two loops is irrelevant).
      for (const name of wfMap.keys()) {
        if (this.registeredWorkflowCommands.has(name)) continue; // already handled
        if (this.registeredJshCommands.has(name)) {
          // A .jsh already installed the unified handler for this name; it already resolves
          // the workflow fallback at dispatch. Just record it so we don't reconsider.
          this.registeredWorkflowCommands.add(name);
          continue;
        }
        if (this.builtinCommandNames.has(name)) continue; // never override a real built-in
        this.bash.registerCommand(this.wrapCommandForSudo(this.makeScriptCommand(name)));
        this.registeredWorkflowCommands.add(name);
        this.builtinCommandNames.add(name);
      }
    } finally {
      this.jshSyncInflight = null;
      if (this.jshSyncDirty) {
        this.jshSyncDirty = false;
        void this.syncJshCommands().catch(() => undefined);
      }
    }
  }

  /**
   * One late-binding handler per script-command name. Resolves precedence at DISPATCH
   * against current VFS state: built-in > .jsh > saved-workflow. (just-bash has no
   * unregister, so we never rebuild the table — the handler reads live discovery each call.)
   */
  private makeScriptCommand(name: string): Command {
    const catalog = this.scriptCatalog;
    const shell = this;
    const discoveryFs = this.options.jshDiscoveryFs ?? this.options.fs;
    const cmdName = name;
    return {
      name,
      // just-bash v3 monkey-patches async primitives in the defense-in-depth sandbox for
      // untrusted commands. The `.jsh` executor reads the script from the VFS and runs it
      // in a worker realm, both of which require unpatched async I/O. Mark the command
      // trusted so just-bash runs it inside `DefenseInDepthBox.runTrustedAsync`, matching
      // how `git`, `mount`, and other host-extension commands are registered.
      trusted: true,
      async execute(args: string[], ctx) {
        const execFn: typeof ctx.exec =
          ctx.exec ??
          ((cmd, opts) =>
            // Forward `args` — the workflow branch passes the `workflow run …` argv via
            // opts.args; dropping it would run a bare `workflow` (just-bash's Bash.exec
            // appends opts.args to the command).
            shell.bash.exec(cmd, {
              env: Object.fromEntries(ctx.env),
              cwd: opts?.cwd ?? ctx.cwd,
              args: opts?.args,
            }));

        // 1) .jsh wins the bare name.
        const jshMap = await catalog.getJshCommands();
        const jshPath = jshMap.get(cmdName);
        if (jshPath) {
          let code: string;
          try {
            const raw = await discoveryFs.readFile(jshPath, { encoding: 'utf-8' });
            code = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
          } catch {
            return { stdout: '', stderr: `jsh: cannot read script '${jshPath}'\n`, exitCode: 127 };
          }
          return executeJsCode(
            code,
            ['node', jshPath, ...args],
            { fs: ctx.fs, cwd: ctx.cwd, env: ctx.env, stdin: ctx.stdin, exec: execFn },
            shell.buildJshProcessConfig()
          );
        }

        // 2) Else a workflow (saved bare or skill <skill>:<name>) — route through the
        //    `workflow run` command path (NOT executeJsCode on the raw file).
        const wfMap = await catalog.getWorkflowCommands();
        const wf = wfMap.get(cmdName);
        if (wf) {
          const argv = buildWorkflowRunArgv(wf.path, args);
          return execFn(argv[0], { args: argv.slice(1), cwd: ctx.cwd });
        }

        // 3) Gone.
        return { stdout: '', stderr: `${cmdName}: command no longer exists\n`, exitCode: 127 };
      },
    };
  }

  private createGitCustomCommand(): Command {
    const gitCommands = this.gitCommands;
    return defineCommand('git', async (args, ctx) => {
      const cwd = ctx.cwd;
      const result = await gitCommands.execute(args, cwd, ctx.env);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
  }

  private createMountCustomCommand(): Command {
    const mountCommands = this.mountCommands;
    return defineCommand('mount', async (args, ctx) => {
      const cwd = ctx.cwd;
      const result = await mountCommands.execute(args, cwd);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
  }

  private async getFilteredJshCommands(): Promise<Map<string, string>> {
    const all = await this.scriptCatalog.getJshCommands();
    const filtered = new Map<string, string>();
    for (const [name, path] of all) {
      if (this.builtinCommandNames.has(name)) continue;
      if (!this.isCommandAllowed(name)) continue;
      filtered.set(name, path);
    }
    return filtered;
  }

  private async getFilteredWorkflowCommands(): Promise<Map<string, WorkflowCommandEntry>> {
    const all = await this.scriptCatalog.getWorkflowCommands();
    const filtered = new Map<string, WorkflowCommandEntry>();
    for (const [name, entry] of all) {
      if (!this.isCommandAllowed(name)) continue;
      filtered.set(name, entry);
    }
    return filtered;
  }

  async getWorkflowCommandNames(): Promise<string[]> {
    return [...(await this.getFilteredWorkflowCommands()).keys()];
  }

  /** `.jsh` fallback when bash returns 127. */
  private async tryJshFallback(command: string): Promise<BashExecResult | null> {
    const trimmed = command.trim();
    const firstSpace = trimmed.indexOf(' ');
    const cmdName = firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed;
    const argsStr = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : '';

    const jshMap = await this.getFilteredJshCommands();
    const scriptPath = jshMap.get(cmdName);
    if (!scriptPath) return null;

    const args = argsStr ? parseShellArgs(argsStr) : [];

    const discoveryFs = this.options.jshDiscoveryFs ?? this.options.fs;
    let code: string;
    try {
      const raw = await discoveryFs.readFile(scriptPath, { encoding: 'utf-8' });
      code = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch {
      return {
        stdout: '',
        stderr: `jsh: cannot read script '${scriptPath}'\n`,
        exitCode: 127,
        env: this.lastEnv,
      };
    }

    const argv = ['node', scriptPath, ...args];
    const result = await executeJsCode(
      code,
      argv,
      {
        fs: this.vfsAdapter,
        cwd: this.cwd,
        env: new Map(Object.entries(this.lastEnv)),
        stdin: EMPTY_BYTES,
        exec: (cmd, opts) => this.bash.exec(cmd, { env: this.lastEnv, cwd: opts?.cwd ?? this.cwd }),
      },
      this.buildJshProcessConfig()
    );

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      env: this.lastEnv,
    };
  }

  /**
   * Build a `JshProcessConfig` from the headless options. Returns
   * `undefined` when no manager is wired (the jsh-executor then
   * skips registration).
   */
  protected buildJshProcessConfig(): JshProcessConfig | undefined {
    if (!this.options.processManager || !this.options.processOwner) return undefined;
    return {
      processManager: this.options.processManager,
      owner: this.options.processOwner,
      getParentPid: this.options.getCurrentShellPid,
    };
  }
}
