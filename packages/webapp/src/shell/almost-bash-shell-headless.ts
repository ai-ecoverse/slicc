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

import type {
  BashExecResult,
  ByteString,
  Command,
  CommandContext,
  CommandName,
  ExecResult,
  ResolvedCommandContext,
} from 'just-bash';
import { Bash, defineCommand, getCommandNames, getNetworkCommandNames } from 'just-bash';
// The shell only FORWARDS a BrowserAPI (to the supplemental commands and
// upskill); it never calls one. Sourcing the type from the sibling that owns
// that dependency keeps this file off the layer-back-edge list — importing it
// from ../cdp/ would be an up-the-stack edge for a type this layer does not
// actually use.
import type { SupplementalCommandsConfig } from './supplemental-commands/index.js';

type BrowserAPI = NonNullable<SupplementalCommandsConfig['browserAPI']>;

import { createLogger } from '../base/logger.js';
import { SUDOERS_D_DIR, type SudoersPolicy, sanitizeGrantPattern } from '../base/sudoers.js';
import type { FsWatcher, VirtualFS } from '../fs/index.js';
import { MountCommands } from '../fs/mount-commands.js';
import { FsError } from '../fs/types.js';
import { GitCommands } from '../git/git-commands.js';
import type { ProcessManager, ProcessOwner } from '../kernel/process-manager.js';
import { getRegisteredProviderConfig } from '../providers/index.js';
import type { SudoBroker } from '../sudo/types.js';
import type { BshDiscoveryFS } from './bsh-discovery.js';
import { DEFAULT_HOME_DIR, resolveHomeDir, userFromHome } from './home-dir.js';
import { DEFAULT_SHELL_PATH, type JshDiscoveryFS, pathToScanRoots } from './jsh-discovery.js';
import type { JshProcessConfig } from './jsh-executor.js';
import { executeJsCode, executeJshFile } from './jsh-executor.js';
import { EMPTY_BYTES } from './just-bash-compat.js';
import { parseShellArgs } from './parse-shell-args.js';
import {
  createFetchProgressObserver,
  makeSleepWithProgress,
  ProgressEmitter,
  planScriptProgress,
  ScriptRun,
  scriptLabel,
  wrapCommandForProgress,
  wrapTimeoutForProgress,
} from './progress/index.js';
import { createProxiedFetch } from './proxied-fetch.js';
import { ScriptCatalog } from './script-catalog.js';
import { enforceCommandSudo } from './sudo/command-guard.js';
import { createSkillCommand, createUpskillCommand } from './supplemental-commands/upskill/index.js';
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
  /** Runtime topology and tray-status readers for the webhook command. */
  webhook?: SupplementalCommandsConfig['webhook'];
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
  /**
   * Secret scrubber for progress-card labels (bash progress overlay,
   * `./progress/`). Labels are built from argv, so without it a
   * `curl -H "Authorization: …"` would surface in the chat UI. Wired by the
   * scoop context with the same scrubber `adaptTools` uses; the human
   * terminal (no tool context) never emits progress and can leave it unset.
   */
  scrubProgressLabel?: (text: string) => Promise<string>;
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
  /**
   * Default disposition for an unmatched (`no-match`) command. The cone uses
   * `'allow'` (only explicit `Cmnd` rules gate); non-cone scoops use
   * `'require-approval'` so any disallowed command escalates to the cone for
   * approval instead of being silently filtered out of the registry. When the
   * default is `'require-approval'`, registration of allow-listed commands is
   * not pre-filtered — every command registers and the dispatch-time gate
   * decides per call.
   */
  defaultDisposition?: import('../base/sudoers.js').DefaultDisposition;
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
  applySessionOverrides?(options: { cwd?: string; env?: Record<string, string> }): void;
  getJshCommandNames(): Promise<string[]>;
  syncJshCommands(): Promise<void>;
  executeCommand(
    command: string,
    signal?: AbortSignal,
    shellPid?: number,
    stdin?: ByteString
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

async function ensureFreshGithubToken(): Promise<void> {
  await getRegisteredProviderConfig('github')?.getValidAccessToken?.();
}

type BashExecOptionsWithSignal = NonNullable<Parameters<Bash['exec']>[1]> & {
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

const log = createLogger('almost-bash-shell');

/**
 * Env var carrying the parent pid of the run a command belongs to.
 *
 * Realm-backed commands (`node` / `python` / `.jsh`) register their realm child
 * under it, so `kill <job pid>` reaches that child and only that child. Reading
 * it from the command's OWN `ctx.env` is what makes parentage exact while
 * several detached runs share one shell — see `AlmostBashShellHeadless`'s
 * per-run parentage note. Internal: stripped from the env written back onto the
 * shell, so it never outlives its run.
 */
const RUN_PID_ENV = '__SLICC_RUN_PID';

/** Read the run's parent pid back out of a command's environment. */
function runPidFromEnv(runEnv?: ReadonlyMap<string, string>): number | undefined {
  const raw = runEnv?.get(RUN_PID_ENV);
  if (raw === undefined) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Copy of `env` without the internal per-run tag. */
function stripRunPid(env: Record<string, string>): Record<string, string> {
  if (!(RUN_PID_ENV in env)) return { ...env };
  const { [RUN_PID_ENV]: _runPid, ...rest } = env;
  return rest;
}

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
  /**
   * The constructor's initial `.jsh` registration, awaited once by the first
   * command and then released. `null` after that (or when never started).
   */
  private initialJshSync: Promise<void> | null = null;
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

  /**
   * The `kind:'shell'` pid of the in-flight `executeCommand` call, set by
   * the caller (`TerminalSessionHost.handleExec` passes the spawned shell
   * proc's pid). Realm-backed commands (`node` / `.jsh` / `python`) parent
   * their realm child to this pid via {@link buildJshProcessConfig}, so a
   * terminal signal to the shell pid fans out to the realm (#1116). Cleared
   * after each exec. Falls back to `options.getCurrentShellPid` (the scoop
   * turn pid) when the caller doesn't supply one.
   */
  private activeShellPid: number | undefined;

  /**
   * Bash progress overlay (`docs/exploration/bash-progress-overlay.md`).
   * Events reach the chat UI through the ambient tool execution context;
   * with none (human terminal) the emitter is a no-op.
   */
  private readonly progress: ProgressEmitter;

  /**
   * Signal of the run currently inside `bash.exec`. just-bash races
   * `ctx.sleep` against the per-command signal but cannot cancel the promise,
   * so the progress ticker probes this between slices. Last-writer under
   * concurrency — a stale read only costs one extra 250 ms tick.
   */
  private activeRunSignal: AbortSignal | undefined;

  /**
   * Script-level progress unit for the run currently inside `bash.exec`
   * (`./progress/script-progress.ts`). One per shell: a second concurrent run
   * (detached job) starting while one is active ends the first rather than
   * miscounting — see `beginScriptRun`.
   */
  private scriptRun: ScriptRun | null = null;
  private scriptRunsActive = 0;

  /** Registry command names, for the script planner's "is this a dispatch" test. */
  private registryNames: ReadonlySet<string> = new Set();

  /**
   * Per-run parent pid, carried to realm-backed commands through the run's
   * OWN environment (see {@link RUN_PID_ENV}).
   *
   * `activeShellPid` alone is a single mutable field, which is correct only
   * while one `executeCommand` is in flight per shell. The agent's `bash` tool
   * breaks that assumption on purpose: a detached run keeps executing after the
   * tool returned, so a later command's pid would be the "active" one when the
   * detached run finally spawns its realm child, and a `kill` would hit the
   * wrong tree.
   *
   * This used to key a `WeakMap` on the run's `AbortSignal`, because just-bash
   * handed every command context the very signal its exec was started with.
   * just-bash >= 3.2 derives a FRESH signal per dispatched command (it composes
   * the caller's signal with the per-command execution-limit budget), so that
   * identity is gone and the map never hit — every realm child silently fell
   * back to `activeShellPid`, i.e. the exact mis-parenting #2210 fixed.
   *
   * `env` is the one per-exec channel just-bash still passes through untouched:
   * concurrent execs on one `Bash` keep separate env maps, and a nested/inner
   * exec inherits its parent's — which is what we want, since it is the same
   * run. The tag is stripped from the env written back onto the shell so a
   * later, untagged run cannot inherit a stale pid.
   */

  /**
   * Stable callback handed to realm-backed commands (`node` / `python`)
   * via `createSupplementalCommands`. Resolves the per-exec jsh process
   * config (PM, owner, parent pid) lazily at command-execution time. A
   * bound class field rather than an inline constructor arrow so the
   * (already large) constructor stays under the cognitive-complexity cap.
   *
   * `runEnv` is the calling command's `ctx.env`; it carries the run's pid tag
   * and so disambiguates concurrent runs (see {@link RUN_PID_ENV}).
   */
  private readonly resolveJshProcessConfig = (
    runEnv?: ReadonlyMap<string, string>
  ): JshProcessConfig | undefined => this.buildJshProcessConfig(runPidFromEnv(runEnv));

  /**
   * When sudo is wired with `defaultDisposition: 'require-approval'` the
   * policy is the single command-enforcement surface (the per-scoop sudoers
   * already encodes `allowedCommands` as `NOPASSWD Cmnd` grants, and any
   * unmatched command escalates to the cone). Pre-filtering registration
   * here would turn a sudo-escalation into a hard "command not found", so
   * skip the filter and let the dispatch-time gate decide per call.
   */
  private static buildAllowedCommandSet(options: HeadlessShellOptions): ReadonlySet<string> | null {
    const sudoEscalatesCommands = options.sudo?.defaultDisposition === 'require-approval';
    if (
      sudoEscalatesCommands ||
      !options.allowedCommands ||
      options.allowedCommands.includes('*')
    ) {
      return null;
    }
    return new Set(options.allowedCommands);
  }

  /**
   * The pre-init environment. HOME here is a synchronous placeholder: the
   * real value is resolved from `/home` (or taken from `options.env.HOME`)
   * in `initHomeAndProfile`, which the first command awaits via the same
   * gate as the `.jsh` scan (#2084) — so no user-visible command ever sees
   * the placeholder.
   */
  private static buildInitialEnv(
    options: HeadlessShellOptions,
    initialCwd: string
  ): Record<string, string> {
    return {
      HOME: DEFAULT_HOME_DIR,
      PATH: DEFAULT_SHELL_PATH,
      USER: 'user',
      SHELL: '/bin/bash',
      // The cone's scratch root (#2267). Scoops pin their own via
      // `options.env` (`buildScoopShellEnv`), which spreads last, so a
      // sandboxed shell never inherits a `/tmp` it may not write.
      TMPDIR: '/tmp',
      PWD: initialCwd,
      ...options.env,
    };
  }

  /** Build the supplemental command set (extracted to keep the constructor under the line cap). */
  private buildSupplementalCommands(
    options: HeadlessShellOptions,
    fetchFn: ReturnType<typeof createProxiedFetch>
  ) {
    return createSupplementalCommands({
      onMediaPreview: async (items) => this.renderMediaPreview(items),
      getJshCommands: () => this.getJshCommandNames(),
      getWorkflowCommands: () => this.getWorkflowCommandNames(),
      syncScriptCommands: () => this.syncJshCommands(),
      getStaticBuiltins: () => [...this.staticBuiltinNames],
      // Names that entered the registry via script registration (.jsh /
      // workflow). just-bash has no unregister, so after a PATH root is
      // removed these stay registered but dispatch 127s — `which` uses this
      // set to skip its registered-name fallback for them (Codex P2, #2143).
      getScriptRegisteredNames: () => [
        ...this.registeredJshCommands.keys(),
        ...this.registeredWorkflowCommands,
      ],
      fs: options.fs,
      fetch: fetchFn,
      scriptCatalog: this.scriptCatalog,
      browserAPI: options.browserAPI,
      webhook: options.webhook,
      getParentJid: options.getParentJid,
      buildProcessConfig: this.resolveJshProcessConfig,
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
  }

  constructor(protected options: HeadlessShellOptions) {
    this.vfsAdapter = new VfsAdapter(options.fs);
    this.progress = new ProgressEmitter({ scrubLabel: options.scrubProgressLabel });
    this.allowedCommands = AlmostBashShellHeadless.buildAllowedCommandSet(options);
    const initialCwd = options.cwd ?? '/';
    const initialEnv = AlmostBashShellHeadless.buildInitialEnv(options, initialCwd);

    this.gitCommands = new GitCommands({
      fs: options.fs,
      authorName: initialEnv.GIT_AUTHOR_NAME ?? 'User',
      authorEmail: initialEnv.GIT_AUTHOR_EMAIL ?? 'user@example.com',
      ensureFreshGithubToken,
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
    const fetchFn = createProxiedFetch({
      progress: createFetchProgressObserver(this.progress),
    });
    const supplementalCommands = this.buildSupplementalCommands(options, fetchFn);
    const mountCommand = this.createMountCustomCommand();

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
      // Deliberately EMPTY: just-bash merges per-exec `options.env` OVER the
      // instance env, so anything seeded here becomes an unremovable floor —
      // `unset` in ~/.profile (or anywhere) could never delete it (Codex P2,
      // #2143). Every `bash.exec` call site threads `this.lastEnv` (seeded
      // from `initialEnv` below), which is the single source of truth.
      env: {},
      fetch: fetchFn,
      commands: allowedBuiltinNames,
      customCommands,
      // Progress-reporting `sleep` (ticks inside just-bash's own timer
      // allowance — see `./progress/sleep-progress.ts`).
      sleep: makeSleepWithProgress(this.progress, {
        isAborted: () => this.activeRunSignal?.aborted ?? false,
      }),
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
    //
    // Progress is layered OUTSIDE sudo (`wrapCommandForProgress(wrapCommandForSudo(cmd))`)
    // so a denied command never runs but still closes its start/end pair;
    // `wrapCommandForSudo` is the identity when gating is off.
    {
      const registry = this.bash as unknown as { commands: Map<string, Command> };
      for (const [name, cmd] of registry.commands) {
        registry.commands.set(name, this.wrapCommandForDispatch(cmd));
      }
      this.registryNames = new Set(registry.commands.keys());
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

    this.startInitialJshSync();
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

  /** Merge per-request overrides into a persistent terminal shell. */
  applySessionOverrides(options: { cwd?: string; env?: Record<string, string> }): void {
    if (options.cwd !== undefined) {
      this.cwd = options.cwd;
      this.lastEnv.PWD = options.cwd;
    }
    if (options.env) Object.assign(this.lastEnv, options.env);
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
    if (this.jshSyncInflight !== null) {
      this.jshSyncDirty = true;
      return this.jshSyncInflight;
    }
    this.jshSyncInflight = this.doSyncJshCommands();
    return this.jshSyncInflight;
  }

  /**
   * One-shot non-streaming command execution. `shellPid`, when supplied
   * (the panel terminal host passes the spawned `kind:'shell'` proc pid),
   * is recorded for the duration so realm-backed commands parent their
   * realm child to it — enabling terminal-signal fan-out to the realm
   * (#1116). Restored to the prior value on return so nested execs are safe.
   */
  async executeCommand(
    command: string,
    signal?: AbortSignal,
    shellPid?: number,
    stdin: ByteString = EMPTY_BYTES
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const previousShellPid = this.activeShellPid;
    if (shellPid !== undefined) this.activeShellPid = shellPid;
    try {
      // `shellPid` also rides this run's env, so a run that outlives the call
      // (the bash tool's detached jobs) still parents its realm children
      // correctly once `activeShellPid` has moved on to a later command.
      const result = await this.runCommand(command, signal, shellPid, stdin);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } finally {
      this.activeShellPid = previousShellPid;
    }
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
  /**
   * Wait for the constructor's `.jsh` registration, but never past an abort.
   *
   * Resolves on whichever comes first: the scan finishing, or `signal`
   * aborting. An abort only stops US waiting — the registration promise keeps
   * running, so the command after the cancelled one still finds a populated
   * table. Without this, Ctrl+C during the first command of a fresh shell is
   * swallowed for however long a full-VFS walk takes.
   */
  /**
   * Begin the constructor's `.jsh` registration and retain it for the first
   * command to await (see `runCommand`). The promise clears itself on settle
   * rather than at the await site: a first command that ABORTS mid-wait must
   * not leave the next one racing the scan again.
   */
  /**
   * The `.jsh` search roots derived from the shell's LIVE `$PATH` (#2085).
   * `~/.profile` runs before the first scan, so a PATH exported there is
   * already in `lastEnv` when the initial registration reads it.
   */
  private currentScanRoots(): string[] {
    return pathToScanRoots(this.lastEnv.PATH);
  }

  private startInitialJshSync(): void {
    this.initialJshSync = this.initHomeAndProfile()
      .then(() => this.syncJshCommands())
      .catch(() => undefined)
      .finally(() => {
        this.initialJshSync = null;
      });
  }

  /**
   * Make `$HOME` real before the first command runs (#2085):
   *
   * 1. Resolve HOME from `/home` (onboarding's `/home/<slug>`), unless the
   *    caller pinned it via `options.env.HOME` (scoops pin their per-scoop
   *    home). `$USER` follows as `basename($HOME)` unless also pinned.
   * 2. `mkdir -p $HOME` so `cd ~` always lands somewhere — this also
   *    re-seeds the directory after a filesystem nuke.
   * 3. Source `$HOME/.profile` when present. This is THE persistence
   *    mechanism for env vars: the file lives in the OPFS-backed VFS, so
   *    `echo 'export FOO=bar' >> ~/.profile` survives reloads and reaches
   *    every future shell — including the per-connection tray exec shells.
   *
   * Runs inside the same init gate the `.jsh` scan uses, so ordering is
   * free: the profile can `export PATH=…` and the scan that follows sees it.
   * The cwd contract is the caller's (a scoop starts in its workspace): a
   * `cd` inside `.profile` changes env like bash would, but the shell's
   * working directory is restored after sourcing.
   */
  private async initHomeAndProfile(): Promise<void> {
    const fs = this.options.fs;
    try {
      const pinnedHome = this.options.env?.HOME;
      const home = pinnedHome ?? (await resolveHomeDir(fs));
      this.lastEnv.HOME = home;
      if (!this.options.env?.USER) {
        this.lastEnv.USER = userFromHome(home);
      }
      // Deliberately NO mkdir here: `options.fs` can be sudo-gated
      // (require-approval scoop shells), and a write at construction time
      // fires an approval escalation before the shell ever ran a command.
      // Directory creation belongs to the structure owners —
      // `ensureRootStructure` / `ensureDirectoryStructure` create `/home/user`
      // and the scoop homes on the raw VFS (including after a filesystem
      // nuke); onboarding creates `/home/<slug>`.

      const profilePath = `${home.replace(/\/+$/, '')}/.profile`;
      if (!(await fs.exists(profilePath).catch(() => false))) return;
      // `.` is just-bash's `source` builtin; quoting handles slugs with
      // shell-special characters. Errors inside the profile must not brick
      // the shell — adopt whatever env survived and move on.
      const result = await this.bash.exec(`. "$HOME/.profile"`, {
        env: this.lastEnv,
        cwd: this.cwd,
      });
      if (result.env) {
        // Adopt the sourced env WHOLESALE (not merged over the old one): the
        // profile received the full env as input, so its result already
        // contains every surviving var — and a merge would resurrect keys the
        // profile `unset` (Codex P2 on #2143). Only PWD keeps the caller's
        // contract.
        const { PWD: _ignoredPwd, ...profileEnv } = result.env;
        this.lastEnv = { ...profileEnv, PWD: this.lastEnv.PWD ?? this.cwd };
      }
    } catch (err) {
      log.warn('HOME/profile init failed; continuing with defaults', err);
    }
  }

  private async waitForInitialJshSync(signal?: AbortSignal): Promise<void> {
    const pending = this.initialJshSync;
    if (pending === null) return;
    if (!signal) {
      await pending;
      return;
    }
    if (signal.aborted) return;

    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(
          () => resolve(),
          () => resolve()
        );
      });
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  protected async runCommand(
    command: string,
    signal?: AbortSignal,
    runPid?: number,
    stdin: ByteString = EMPTY_BYTES
  ): Promise<BashExecResult> {
    const commandName = command.trim().split(/\s+/)[0] || 'unknown';
    emitShellCommand(commandName);

    // Wait for the constructor's `.jsh` registration before the first command.
    //
    // WHY THIS IS NOT COVERED BY `tryJshFallback`. That fallback fires on
    // `result.exitCode === 127`, which only surfaces when the WHOLE command is
    // one unknown name. In a pipeline or a `;`-separated list the unknown
    // command fails with 127 *inside* bash while the compound reports its last
    // command's status — so the miss is invisible and the fallback never runs.
    // `signal watches` therefore worked on a cold shell while
    // `signal watches; echo done` did not.
    //
    // A long-lived shell (the agent's, the panel terminal's) finished
    // registering long ago and never notices. A shell built per use does: the
    // tray's `slicc … exec` constructs a fresh one for every follower
    // connection, so EVERY compound command raced the scan and lost.
    //
    // Awaited once — the promise clears itself when it settles, so subsequent
    // commands pay nothing. Abortable: the scan walks `/` and takes seconds on
    // a populated instance, and a Ctrl+C that only lands after it finishes is
    // not a Ctrl+C. On abort we stop WAITING but let the registration run on in
    // the background, so the next command still benefits.
    await this.waitForInitialJshSync(signal);

    // just-bash's published ExecOptions type does not yet expose
    // AbortSignal, but we still forward it so external callers and
    // terminal Ctrl+C keep a consistent cancellation path.
    const execOptions: BashExecOptionsWithSignal = {
      // Tagged per run so realm-backed commands can recover THIS run's parent
      // pid from their own `ctx.env` under concurrency (see `RUN_PID_ENV`).
      env: runPid === undefined ? this.lastEnv : { ...this.lastEnv, [RUN_PID_ENV]: String(runPid) },
      cwd: this.cwd,
      signal,
      ...(stdin !== EMPTY_BYTES
        ? { stdin: stdin as unknown as string, stdinKind: 'bytes' as const }
        : {}),
    };
    const pathBeforeExec = this.lastEnv.PATH;
    this.activeRunSignal = signal;
    const scriptRun = this.beginScriptRun(command);
    let result: BashExecResult;
    try {
      result = await this.bash.exec(command, execOptions);
    } finally {
      if (this.activeRunSignal === signal) this.activeRunSignal = undefined;
      this.endScriptRun(scriptRun);
    }
    // Persist any "Always" command grants confirmed during dispatch now that we
    // are outside just-bash's execution box (where VFS async timers are blocked).
    await this.flushPendingCommandGrants();
    if (result.env) {
      // Drop the per-run tag: it belongs to the run that just finished, and a
      // later untagged run must not inherit its pid.
      this.lastEnv = stripRunPid(result.env);
    }
    // `export PATH=…` changes where commands live (#2085): re-register before
    // the next command so `mytool` works immediately after `export PATH=…;`.
    // Awaited — the scan is bounded by the PATH roots, and returning before it
    // finishes would reintroduce the #2084 race for the very command sequences
    // that just extended the PATH.
    if (result.env && this.lastEnv.PATH !== pathBeforeExec) {
      await this.syncJshCommands().catch(() => undefined);
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
      const jshResult = await this.tryJshFallback(command, runPid);
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
  /**
   * Dispatch-time decorators for a registry entry: sudo gate inside, progress
   * start/end outside. Every command registered after construction (`.jsh`,
   * workflows) must go through this too.
   */
  private wrapCommandForDispatch(command: Command): Command {
    const inner = this.wrapCommandForSudo(command);
    const wrapped =
      command.name === 'timeout'
        ? wrapTimeoutForProgress(inner, this.progress)
        : wrapCommandForProgress(inner, this.progress);
    const onSettled = () => this.scriptRun?.stepDone();
    return {
      ...wrapped,
      async execute(args, ctx) {
        // Step counting seam: every registry dispatch, including the ones
        // `wrapCommandForProgress` skips (`echo`, …). Counted on COMPLETION so
        // the script bar advances when a step finishes, not when it starts.
        // O(1) when no script unit is active.
        try {
          return await wrapped.execute(args, ctx);
        } finally {
          onSettled();
        }
      },
    };
  }

  /** Open the script-level progress unit for a script about to run. */
  private beginScriptRun(command: string): ScriptRun | null {
    this.scriptRunsActive += 1;
    if (!this.progress.hasSink()) return null;
    if (this.scriptRunsActive > 1) {
      // Concurrent runs share one dispatch stream — close the first rather
      // than let both miscount; the newer run gets no unit either.
      this.scriptRun?.end();
      this.scriptRun = null;
      return null;
    }
    // `transform()` re-parses (cheap; just-bash parses again in `exec`). A
    // parse error here just means an indeterminate unit — exec reports it.
    let plan: ReturnType<typeof planScriptProgress> = { totalSteps: null };
    try {
      plan = planScriptProgress(this.bash.transform(command).ast, this.registryNames);
    } catch {
      plan = { totalSteps: null };
    }
    this.scriptRun = new ScriptRun(plan, this.progress, scriptLabel(command));
    return this.scriptRun;
  }

  private endScriptRun(run: ScriptRun | null): void {
    this.scriptRunsActive = Math.max(0, this.scriptRunsActive - 1);
    if (run) {
      run.end();
      if (this.scriptRun === run) this.scriptRun = null;
    }
  }

  private wrapCommandForSudo(command: Command): Command {
    if (!this.isTransparentGatingEnabled()) return command;
    const guard = (args: string[]) => this.gateCommandDispatch(command.name, args);
    return {
      name: command.name,
      trusted: command.trusted,
      async execute(args: string[], ctx: ResolvedCommandContext): Promise<ExecResult> {
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
      defaultDisposition: sudo.defaultDisposition,
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
    } catch (err) {
      if (!(err instanceof FsError && err.code === 'ENOENT')) throw err;
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
      const jshMap = await this.scriptCatalog.getJshCommands(this.currentScanRoots());
      const wfMap = await this.getFilteredWorkflowCommands();

      // .jsh names: keep the existing path-keyed registry + guard.
      for (const [name, scriptPath] of jshMap) {
        if (!this.isCommandAllowed(name)) continue;
        if (this.builtinCommandNames.has(name) && !this.registeredJshCommands.has(name)) continue;
        if (this.registeredJshCommands.get(name) === scriptPath) continue;
        this.bash.registerCommand(this.wrapCommandForDispatch(this.makeScriptCommand(name)));
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
        this.bash.registerCommand(this.wrapCommandForDispatch(this.makeScriptCommand(name)));
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
    const discoveryFs = this.options.jshDiscoveryFs ?? this.options.fs;
    const cmdName = name;
    const executeInner = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
      const execFn: typeof ctx.exec =
        ctx.exec ??
        ((cmd, opts) =>
          // Forward `args` — the workflow branch passes the `workflow run …` argv via
          // opts.args; dropping it would run a bare `workflow` (just-bash's Bash.exec
          // appends opts.args to the command).
          this.bash.exec(cmd, {
            env: Object.fromEntries(ctx.env),
            cwd: opts?.cwd ?? ctx.cwd,
            args: opts?.args,
          }));

      // 1) .jsh wins the bare name.
      const jshMap = await catalog.getJshCommands(this.currentScanRoots());
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
          this.buildJshProcessConfig(runPidFromEnv(ctx.env))
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
    };
    return {
      name,
      // just-bash v3 monkey-patches async primitives in the defense-in-depth sandbox for
      // untrusted commands. The `.jsh` executor reads the script from the VFS and runs it
      // in a worker realm, both of which require unpatched async I/O. Mark the command
      // trusted so just-bash runs it inside `DefenseInDepthBox.runTrustedAsync`, matching
      // how `git`, `mount`, and other host-extension commands are registered.
      trusted: true,
      async execute(args: string[], ctx) {
        // A THROW from a .jsh escapes into just-bash's error sanitizer,
        // which rewrites path-like substrings to the literal `<path>` —
        // destroying the only diagnostic the user gets (#2146 finding 2,
        // and the mis-diagnosed #1033-1 scrub in git/clone.ts). Convert
        // failures into ordinary results so the message survives verbatim.
        try {
          return await executeInner(args, ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { stdout: '', stderr: `${cmdName}: ${message}\n`, exitCode: 1 };
        }
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
      const result = await mountCommands.execute(args, cwd, ctx.env);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
  }

  private async getFilteredJshCommands(): Promise<Map<string, string>> {
    const all = await this.scriptCatalog.getJshCommands(this.currentScanRoots());
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

  /**
   * `.jsh` fallback when bash returns 127.
   *
   * `runPid` is the originating run's parent pid — passed straight down (we are
   * still in that run's own frame here) so a `.jsh` reached through the fallback
   * parents its realm child to the job that ran it, not to whichever concurrent
   * run happens to be active.
   */
  private async tryJshFallback(command: string, runPid?: number): Promise<BashExecResult | null> {
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
      this.buildJshProcessConfig(runPid)
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
  protected buildJshProcessConfig(runPid?: number): JshProcessConfig | undefined {
    if (!this.options.processManager || !this.options.processOwner) return undefined;
    return {
      processManager: this.options.processManager,
      owner: this.options.processOwner,
      // Preference order: the pid carried by THIS run (exact under concurrency
      // — the agent's bash tool detaches runs, so several can be in flight on
      // one shell), then the per-exec field the panel terminal sets, then the
      // static `getCurrentShellPid` (scoop turn pid).
      getParentPid: () => runPid ?? this.activeShellPid ?? this.options.getCurrentShellPid?.(),
    };
  }
}
