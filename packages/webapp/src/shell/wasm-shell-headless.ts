/**
 * `WasmShellHeadless` — the worker-safe shell base class.
 *
 * Phase 2b. The agent's `bash` tool calls run here. Owns just-bash,
 * the VFS adapter, custom commands (git, mount, supplemental), the
 * `.jsh` discovery + sync loop, and the `executeCommand` /
 * `executeScriptFile` primitives. Zero DOM — the file lives outside
 * `tsconfig.webapp-worker.json`'s include list today only because of
 * its transitive imports, but every line of this class is worker-
 * safe in principle (`setInterval`, `IndexedDB`-backed VFS, no
 * `window`/`document`).
 *
 * The view layer — `WasmShell` in `wasm-shell.ts` — extends this
 * class and adds xterm mounting, the line editor, history, and
 * media-preview rendering. Worker-resident shells construct
 * `WasmShellHeadless` directly (or — equivalently for now —
 * `WasmShell`, which inherits the headless behavior and only
 * activates view code on `mount()`).
 *
 * `renderMediaPreview` is a `protected` extension point: the
 * headless implementation throws "preview unavailable in headless
 * mode" because there's no DOM to draw into; `WasmShell` overrides
 * with the existing image/video preview logic. Phase 2b's terminal
 * RPC will replace the throw with a `terminal-media-preview`
 * envelope emit.
 */

import type { FsWatcher, VirtualFS } from '../fs/index.js';
import { Bash, defineCommand, getCommandNames, getNetworkCommandNames } from 'just-bash';
import type { BashExecResult, Command, CommandName } from 'just-bash';
import { VfsAdapter } from './vfs-adapter.js';
import { GitCommands } from '../git/git-commands.js';
import { createSupplementalCommands } from './supplemental-commands.js';
import type { MediaPreviewItem } from './supplemental-commands.js';
import type { BrowserAPI } from '../cdp/index.js';
import {
  createSkillCommand,
  createUpskillCommand,
} from './supplemental-commands/upskill-command.js';
import { MountCommands } from '../fs/mount-commands.js';
import type { ProcessManager, ProcessOwner } from '../kernel/process-manager.js';
import type { JshProcessConfig } from './jsh-executor.js';
import type { BshDiscoveryFS } from './bsh-discovery.js';
import type { JshDiscoveryFS } from './jsh-discovery.js';
import { executeJshFile, executeJsCode } from './jsh-executor.js';
import { parseShellArgs } from './parse-shell-args.js';
import { ScriptCatalog } from './script-catalog.js';
import { trackShellCommand } from '../ui/telemetry.js';
import { createProxiedFetch } from './proxied-fetch.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Worker-safe slice of `WasmShellOptions` (no DOM `container`). */
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
   * Phase 3.5 — process manager for `kind:'jsh'` registration.
   * When omitted, the shell falls back to its pre-Phase-3 behavior
   * (no `.jsh` script visibility in `ps`). When supplied alongside
   * `processOwner`, every `executeScriptFile` and `node -e` call
   * registers a process record under the active shell's pid (when
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
   * `ppid: 1` (kernel-host anchor) — Phase 4 `ps -T` will still
   * show them but as orphans.
   */
  getCurrentShellPid?: () => number | undefined;
}

// ---------------------------------------------------------------------------
// Headless surface (interface)
// ---------------------------------------------------------------------------

/**
 * The shell methods the kernel worker (and any future
 * terminal-view-driven RPC client) needs. `WasmShell` and
 * `WasmShellHeadless` both satisfy this.
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

export class WasmShellHeadless implements HeadlessShellLike {
  protected bash: Bash;
  protected vfsAdapter: VfsAdapter;
  protected gitCommands: GitCommands;
  protected mountCommands: MountCommands;
  /** Accumulated env state from successive exec() calls. */
  protected lastEnv: Record<string, string>;
  protected cwd: string;
  /** Set of all built-in + custom command names (for shadowing protection). */
  protected builtinCommandNames: Set<string>;
  /**
   * Allow-list of command names. `null` means unrestricted — every command is
   * permitted. Otherwise only names in the set may be registered or executed.
   */
  protected readonly allowedCommands: ReadonlySet<string> | null;
  protected readonly scriptCatalog: ScriptCatalog;
  protected readonly ownsScriptCatalog: boolean;
  /** Maps .jsh command names to their registered script paths. */
  protected registeredJshCommands = new Map<string, string>();
  /** Promise for the currently in-flight jsh sync. */
  private jshSyncInflight: Promise<void> | null = null;
  /** Re-sync requested while one was already in flight. */
  private jshSyncDirty = false;

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
        (path) => path.endsWith('.jsh'),
        () => {
          void this.syncJshCommands().catch(() => undefined);
        }
      );
    }

    const gitCommand = this.createGitCustomCommand();
    const supplementalCommands = createSupplementalCommands({
      onMediaPreview: async (items) => this.renderMediaPreview(items),
      getJshCommands: () => this.getJshCommandNames(),
      fs: options.fs,
      scriptCatalog: this.scriptCatalog,
      browserAPI: options.browserAPI,
      getParentJid: options.getParentJid,
    });
    const mountCommand = this.createMountCustomCommand();
    const fetchFn = createProxiedFetch();

    const allCustomCommands = [
      gitCommand,
      mountCommand,
      createSkillCommand(options.fs),
      createUpskillCommand(options.fs, fetchFn),
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

    const customCommandNames = customCommands.map((c) => c.name);
    const registeredBuiltinNames = allowedBuiltinNames ?? [
      ...getCommandNames(),
      ...getNetworkCommandNames(),
    ];
    this.builtinCommandNames = new Set([...registeredBuiltinNames, ...customCommandNames]);
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
        stdin: '',
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
   * `WasmShell` view subclass overrides with the existing
   * image/video preview rendering. Phase 2b's terminal RPC will add
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
    trackShellCommand(commandName);

    // just-bash's published ExecOptions type does not yet expose
    // AbortSignal, but we still forward it so external callers and
    // terminal Ctrl+C keep a consistent cancellation path.
    const execOptions: BashExecOptionsWithSignal = {
      env: this.lastEnv,
      cwd: this.cwd,
      signal,
    };
    const result = await this.bash.exec(command, execOptions);
    if (result.env) {
      this.lastEnv = { ...result.env };
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

  /** True when `name` is registrable/executable under the allow-list. */
  private isCommandAllowed(name: string): boolean {
    return this.allowedCommands === null || this.allowedCommands.has(name);
  }

  private async doSyncJshCommands(): Promise<void> {
    try {
      const jshMap = await this.scriptCatalog.getJshCommands();
      const discoveryFs = this.options.jshDiscoveryFs ?? this.options.fs;

      for (const [name, scriptPath] of jshMap) {
        if (!this.isCommandAllowed(name)) continue;
        if (this.builtinCommandNames.has(name) && !this.registeredJshCommands.has(name)) {
          continue;
        }
        if (this.registeredJshCommands.get(name) === scriptPath) continue;

        const catalog = this.scriptCatalog;
        const shell = this;
        const cmdName = name;

        const command: Command = {
          name,
          async execute(args: string[], ctx) {
            const currentMap = await catalog.getJshCommands();
            const currentPath = currentMap.get(cmdName);
            if (!currentPath) {
              return {
                stdout: '',
                stderr: `jsh: command '${cmdName}' no longer exists\n`,
                exitCode: 127,
              };
            }
            let code: string;
            try {
              const raw = await discoveryFs.readFile(currentPath, { encoding: 'utf-8' });
              code = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
            } catch {
              return {
                stdout: '',
                stderr: `jsh: cannot read script '${currentPath}'\n`,
                exitCode: 127,
              };
            }
            const argv = ['node', currentPath, ...args];
            const execFn: typeof ctx.exec =
              ctx.exec ??
              ((cmd, opts) =>
                shell.bash.exec(cmd, {
                  env: Object.fromEntries(ctx.env),
                  cwd: opts?.cwd ?? ctx.cwd,
                }));
            return executeJsCode(
              code,
              argv,
              {
                fs: ctx.fs,
                cwd: ctx.cwd,
                env: ctx.env,
                stdin: ctx.stdin,
                exec: execFn,
              },
              shell.buildJshProcessConfig()
            );
          },
        };

        this.bash.registerCommand(command);
        this.registeredJshCommands.set(name, scriptPath);
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

  private createGitCustomCommand(): Command {
    const gitCommands = this.gitCommands;
    return defineCommand('git', async (args, ctx) => {
      const cwd = ctx.cwd;
      const result = await gitCommands.execute(args, cwd);
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
        stdin: '',
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
