/**
 * `AlmostBashShellHeadless` — the worker-safe shell orchestrator.
 *
 * The agent's `bash` tool calls run here. Owns just-bash, the VFS
 * adapter, cwd/env, and `runCommand`. Script discovery, sudo/grants,
 * and the GNU-bash path live on collaborators (`JshCommandRegistry`,
 * `CommandGate`, `GnuBashFallback`). Zero DOM in this class's own
 * code (`setInterval`, `IndexedDB`-backed VFS only). Shell-command
 * telemetry is emitted through the dependency-inverted
 * `telemetry-hook.ts` sink (the UI registers `trackShellCommand`)
 * rather than importing `ui/telemetry.ts` directly, so the shell no
 * longer carries a back-edge into the `ui/` layer. The file still
 * lives outside `tsconfig.webapp-worker.json`'s no-DOM include
 * because its remaining (type-only) `cdp/` imports transitively reach
 * the DOM-bound CDP transports.
 *
 * The view layer — `AlmostBashShell` in `almost-bash-shell.ts` — extends this
 * class and adds terminal mounting, the line editor, history, and
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
import type { FsWatcher, VirtualFS } from '../fs/index.js';
import { MountCommands } from '../fs/mount-commands.js';
import { GitCommands } from '../git/git-commands.js';
import { ensureFreshGithubToken, githubOAuthDomains } from '../git/github-oauth.js';
import type { ProcessManager, ProcessOwner } from '../kernel/process-manager.js';
import type { BshDiscoveryFS } from './bsh-discovery.js';
import { CommandGate, type ShellSudoConfig } from './command-gate.js';
import { filesystemExecutionLimits } from './filesystem-budgets.js';
import { GnuBashFallback } from './gnu-bash-fallback.js';
import { DEFAULT_HOME_DIR, resolveHomeDir, userFromHome } from './home-dir.js';
import { isInstalledProgramPath } from './ipk/wasm-programs.js';
import { JshCommandRegistry } from './jsh-command-registry.js';
import { DEFAULT_SHELL_PATH, type JshDiscoveryFS } from './jsh-discovery.js';
import type { JshProcessConfig } from './jsh-executor.js';
import { executeJshFile } from './jsh-executor.js';
import { EMPTY_BYTES, stdinAsText } from './just-bash-compat.js';
import {
  applyCapturedPipeStatus,
  attachPipeStatus,
  PIPESTATUS_ENV,
  PIPESTATUS_EXIT_ENV,
  scriptForPipeStatusCapture,
} from './pipe-status.js';
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
import {
  createProxiedFetch,
  createProxiedStreamingFetch,
  type StreamingFetch,
} from './proxied-fetch.js';
import { clearReadByteProvenance } from './request-body-provenance.js';
import { OUTPUT_TEE_ENV, RUN_PID_ENV, runPidFromEnv } from './run-env.js';
import { ScriptCatalog } from './script-catalog.js';
import { settleOnAbort } from './settle-on-abort.js';
import { extractLeadingCommentReason, SUDO_REASON_ENV } from './sudo/command-reason.js';
import { PLUMBING } from './supplemental-commands/git-credential-command.js';
import { runMountDirectoryApproval } from './supplemental-commands/mount-directory-approval.js';
import { sayStdioPlugin } from './supplemental-commands/say-stdio-rewrite.js';
import { createSkillCommand, createUpskillCommand } from './supplemental-commands/upskill/index.js';
import type { MediaPreviewItem } from './supplemental-commands.js';
import { createSupplementalCommands } from './supplemental-commands.js';
import { emitShellCommand } from './telemetry-hook.js';
import type { TerminalPort } from './terminal-port.js';
import { VfsAdapter } from './vfs-adapter.js';

export type { ShellSudoConfig };

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
  /** Runtime topology reader for the crontask command. */
  crontask?: SupplementalCommandsConfig['crontask'];
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
  /** The panel terminal this shell runs in, which a program can lease (`wasm -t`). */
  terminal?: TerminalPort;
  /**
   * Run commands on GNU bash when a package provides it (`gnu-bash.ts`); the
   * agent's shells set this. `SLICC_SHELL=just-bash` in the environment opts out.
   */
  gnuBash?: boolean;
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
  /** Shared MCP connection manager. When supplied, `mcp` subcommands route through live connections. */
  mcpConnectionManager?: SupplementalCommandsConfig['mcpConnectionManager'];
  /** Named just-bash preset. Defaults to normal; this does not set an OPFS storage quota. */
  executionLimitProfile?: NonNullable<
    ConstructorParameters<typeof Bash>[0]
  >['executionLimitProfile'];
  /**
   * Trusted overrides for just-bash limits. Child scoop shells use bounded
   * filesystem budgets; cones and terminals keep the bundled defaults.
   * maxFileSystemBytes applies only to Bash's default InMemoryFs, not our VFS.
   */
  executionLimits?: NonNullable<ConstructorParameters<typeof Bash>[0]>['executionLimits'];
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
    stdin?: ByteString,
    options?: ExecuteCommandOptions
  ): Promise<ShellCommandResult>;
  executeScriptFile(
    scriptPath: string,
    args?: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Result of {@link HeadlessShellLike.executeCommand}. */
export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Per-stage codes from the last pipeline (`PIPESTATUS`). Present only when
   * {@link ExecuteCommandOptions.capturePipeStatus} was set and the capture
   * trailer ran (skipped on `set -e` abort or a bare `exit`).
   */
  pipeStatus?: number[];
}

/** Optional knobs for {@link HeadlessShellLike.executeCommand}. */
export interface ExecuteCommandOptions {
  /**
   * Called with each registry-dispatched command's stdout+stderr as that
   * command settles — the incremental tee used by the agent `bash` tool so a
   * detached job killed by `timeout` still has its pre-kill output on disk
   * (#2415). Concurrent runs on one shell are demuxed via an internal env tag.
   */
  onOutput?: (chunk: string) => void;
  /**
   * Record PIPESTATUS for this run (agent `bash` tool). The last-stage exit
   * code is unchanged; `pipeStatus` is returned separately.
   */
  capturePipeStatus?: boolean;
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

const log = createLogger('almost-bash-shell');

/** Copy of `env` without the internal per-run tags. */
function stripRunPid(env: Record<string, string>): Record<string, string> {
  if (
    !(RUN_PID_ENV in env) &&
    !(OUTPUT_TEE_ENV in env) &&
    !(SUDO_REASON_ENV in env) &&
    !(PIPESTATUS_ENV in env) &&
    !(PIPESTATUS_EXIT_ENV in env)
  ) {
    return { ...env };
  }
  const {
    [RUN_PID_ENV]: _runPid,
    [OUTPUT_TEE_ENV]: _tee,
    [SUDO_REASON_ENV]: _reason,
    [PIPESTATUS_ENV]: _pipeStatus,
    [PIPESTATUS_EXIT_ENV]: _pipeExit,
    ...rest
  } = env;
  return rest;
}

/** One signal that aborts when any of `cuts` does. `release` drops the listeners. */
function linkAbort(cuts: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  release(): void;
} {
  const linked = new AbortController();
  const live = cuts.filter((cut): cut is AbortSignal => cut !== undefined);
  const onCut = (): void => linked.abort();
  for (const cut of live) {
    if (cut.aborted) linked.abort();
    else cut.addEventListener('abort', onCut, { once: true });
  }
  return {
    signal: linked.signal,
    release() {
      for (const cut of live) cut.removeEventListener('abort', onCut);
    },
  };
}

export class AlmostBashShellHeadless implements HeadlessShellLike {
  protected bash: Bash;
  protected vfsAdapter: VfsAdapter;
  protected gitCommands: GitCommands;
  protected mountCommands: MountCommands;
  /** Accumulated env state from successive exec() calls. */
  protected lastEnv: Record<string, string>;
  protected cwd: string;
  /**
   * The shell's file-creation mask (`umask`), carried between `exec` calls
   * like `lastEnv`: just-bash reports the final mask of each run.
   */
  protected umask = 0o022;
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
  private readonly commandGate: CommandGate;
  private jshRegistry!: JshCommandRegistry;
  private gnuBashFallback!: GnuBashFallback;
  /**
   * Env writes performed by supplemental commands during a `bash.exec()` call
   * (`secret set` injecting a masked value, `secret delete` dropping one).
   * `bash.exec()` returns its own snapshot of the working env that overwrites
   * `lastEnv` on return — these pending writes are reapplied after that
   * overwrite so they survive into the next exec call. A `null` value is a
   * pending REMOVAL: the snapshot still carries the old value, so the var has
   * to be deleted again after the overwrite, not just before it.
   */
  private pendingEnvWrites = new Map<string, string | null>();

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
   * Aborted by {@link cancelActiveCommand} to cut a run whose own signal
   * the caller cannot reach (a turn force-release). Replaced on each cancel
   * so the next command is not born already aborted.
   */
  private commandAbort = new AbortController();

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
   * Incremental stdout/stderr tees keyed by {@link OUTPUT_TEE_ENV} (#2415).
   * Populated for the duration of an `executeCommand` that requested `onOutput`.
   */
  private readonly outputTees = new Map<string, (chunk: string) => void>();
  private nextOutputTeeId = 0;

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
      // Floor value for a shell with no work unit behind it (the panel
      // terminal, tests). A unit's own scratch directory is pinned over it by
      // `buildScoopShellEnv` via `options.env`, which spreads last (#2267).
      TMPDIR: '/tmp',
      PWD: initialCwd,
      ...options.env,
    };
  }

  /** Build the supplemental command set (extracted to keep the constructor under the line cap). */
  private buildSupplementalCommands(
    options: HeadlessShellOptions,
    fetchFn: ReturnType<typeof createProxiedFetch>,
    streamFetch: StreamingFetch
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
      getScriptRegisteredNames: () => this.jshRegistry.scriptRegisteredNames(),
      fs: options.fs,
      fetch: fetchFn,
      streamFetch,
      scriptCatalog: this.scriptCatalog,
      browserAPI: options.browserAPI,
      webhook: options.webhook,
      crontask: options.crontask,
      getParentJid: options.getParentJid,
      isScoop: options.isScoop,
      buildProcessConfig: this.resolveJshProcessConfig,
      terminal: options.terminal,
      gateNativeCommand: this.gateNativeCommand,
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
              this.commandGate.queueGrant(pattern);
            },
            suppressNextGate: (subject) => this.commandGate.registerSudoBypass(subject),
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
      // `secret delete` must also drop the var, and the removal has to be
      // queued the same way: `bash.exec`'s returned env snapshot still carries
      // the old value, so deleting it from `lastEnv` alone would be undone on
      // return and the mask would come back.
      unsetEnv: (name) => {
        this.pendingEnvWrites.set(name, null);
        delete this.lastEnv[name];
      },
      // `git-credential-slicc` hands native git the token this shell's `git`
      // uses (freshened the same way), where the OAuth token may go.
      gitCredential: {
        githubToken: (env, opts) => this.gitCommands.githubCredential(env, opts),
        githubDomains: githubOAuthDomains,
      },
      gitIdentity: () => this.gitCommands.identity(),
      mcpConnectionManager: options.mcpConnectionManager,
    });
  }

  constructor(protected options: HeadlessShellOptions) {
    this.vfsAdapter = new VfsAdapter(options.fs);
    this.progress = new ProgressEmitter({ scrubLabel: options.scrubProgressLabel });
    this.allowedCommands = AlmostBashShellHeadless.buildAllowedCommandSet(options);
    this.commandGate = new CommandGate({
      getSudo: () => this.options.sudo,
      fs: options.fs,
    });
    const initialCwd = options.cwd ?? '/';
    const initialEnv = AlmostBashShellHeadless.buildInitialEnv(options, initialCwd);

    this.gitCommands = new GitCommands({
      fs: options.fs,
      authorName: initialEnv.GIT_AUTHOR_NAME ?? 'User',
      authorEmail: initialEnv.GIT_AUTHOR_EMAIL ?? 'user@example.com',
      ensureFreshGithubToken,
    });

    this.mountCommands = new MountCommands({
      fs: options.fs,
      isScoop: options.isScoop,
      acquireLocalMountViaToolUI: runMountDirectoryApproval,
    });

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
        (path) =>
          path.endsWith('.jsh') || path.endsWith('.workflow.js') || isInstalledProgramPath(path),
        () => {
          void this.syncJshCommands().catch(() => undefined);
        }
      );
    }

    const gitCommand = this.createGitCustomCommand();
    const fetchFn = createProxiedFetch({
      progress: createFetchProgressObserver(this.progress),
    });
    const streamFetch = createProxiedStreamingFetch({
      progress: createFetchProgressObserver(this.progress),
    });
    const supplementalCommands = this.buildSupplementalCommands(options, fetchFn, streamFetch);
    const mountCommand = this.createMountCustomCommand();
    const umountCommand = this.createUmountCustomCommand();

    const allCustomCommands = [
      gitCommand,
      mountCommand,
      umountCommand,
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
      executionLimitProfile: options.executionLimitProfile,
      executionLimits: filesystemExecutionLimits(
        options.isScoop?.() ?? false,
        options.executionLimits
      ),
    });
    // just-bash never flags isatty on the command context. Inject `say -o -`
    // when stdout is a pipe/redirect/capture so WAV bytes reach the consumer
    // (#3178); TTY `say text` is unchanged. `exec()` applies this plugin.
    this.bash.registerTransformPlugin(sayStdioPlugin);

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
    // `/etc/passwd`'s account follows the shell's identity (a scoop's, an onboarded home).
    this.vfsAdapter.setIdentityFn(() => ({
      user: this.lastEnv.USER ?? 'user',
      home: this.lastEnv.HOME ?? DEFAULT_HOME_DIR,
    }));

    this.lastEnv = { ...initialEnv };
    this.cwd = initialCwd;
    this.bindCollaborators(options);

    this.startInitialJshSync();
  }

  /** Wire jsh/wasm/workflow discovery and the GNU-bash path once bash exists. */
  private bindCollaborators(options: HeadlessShellOptions): void {
    const self = this;
    this.jshRegistry = new JshCommandRegistry({
      get bash() {
        return self.bash;
      },
      scriptCatalog: this.scriptCatalog,
      discoveryFs: options.jshDiscoveryFs ?? options.fs,
      vfsAdapter: this.vfsAdapter,
      get cwd() {
        return self.cwd;
      },
      get lastEnv() {
        return self.lastEnv;
      },
      get umask() {
        return self.umask;
      },
      builtinCommandNames: this.builtinCommandNames,
      isCommandAllowed: (name) => this.isCommandAllowed(name),
      wrapCommandForDispatch: (command) => this.wrapCommandForDispatch(command),
      path: () => this.lastEnv.PATH,
      buildJshProcessConfig: (runPid) => this.buildJshProcessConfig(runPid),
      gateNativeCommand: this.gateNativeCommand,
      gitIdentity: () => this.gitCommands.identity(),
    });
    this.gnuBashFallback = new GnuBashFallback({
      gnuBash: options.gnuBash === true,
      get lastEnv() {
        return self.lastEnv;
      },
      get cwd() {
        return self.cwd;
      },
      get umask() {
        return self.umask;
      },
      vfsAdapter: this.vfsAdapter,
      get bash() {
        return self.bash;
      },
      scriptCatalog: this.scriptCatalog,
      outputTees: this.outputTees,
      gateNativeCommand: this.gateNativeCommand,
      buildJshProcessConfig: (runPid) => this.buildJshProcessConfig(runPid),
      gitIdentity: () => this.gitCommands.identity(),
      flushPendingCommandGrants: () => this.commandGate.flushPendingCommandGrants(),
      applyPendingEnvWrites: () => this.applyPendingEnvWrites(),
      syncJshCommands: () => this.syncJshCommands(),
      adoptCwd: (cwd) => {
        this.cwd = cwd;
      },
      adoptEnv: (env) => {
        this.lastEnv = env;
      },
    });
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

  /**
   * Publish a masked secret value as `$name` for the rest of the session.
   *
   * The same write `secret set` performs through its internal `setEnv` hook,
   * exposed for callers OUTSIDE a `bash.exec()` — the `request_secret` tool,
   * whose secret is stored by the page while no command is running. Queued as
   * well as applied because the next `exec` overwrites `lastEnv` with its own
   * snapshot, which does not know about this write.
   *
   * Masked values only: a real credential in the shell env is exactly what the
   * masking pipeline exists to prevent.
   */
  setMaskedEnvVar(name: string, maskedValue: string): void {
    this.pendingEnvWrites.set(name, maskedValue);
    this.lastEnv[name] = maskedValue;
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
    return this.jshRegistry.getJshCommandNames();
  }

  /**
   * Discover `.jsh` commands and register any new ones as just-bash
   * custom commands. Idempotent; in-flight calls coalesce.
   */
  async syncJshCommands(): Promise<void> {
    return this.jshRegistry.syncJshCommands();
  }

  /**
   * One-shot non-streaming command execution. `shellPid`, when supplied
   * (the panel terminal host passes the spawned `kind:'shell'` proc pid),
   * is recorded for the duration so realm-backed commands parent their
   * realm child to it — enabling terminal-signal fan-out to the realm
   * (#1116). Restored to the prior value on return so nested execs are safe.
   */
  /**
   * Abort the run currently inside `bash.exec`, if any. A stop that only
   * signals the turn leaves a custom command (one that never reads its
   * signal) holding this shell, and the next `exec` waits behind it.
   */
  cancelActiveCommand(): void {
    this.commandAbort.abort();
    this.commandAbort = new AbortController();
  }

  async executeCommand(
    command: string,
    signal?: AbortSignal,
    shellPid?: number,
    stdin: ByteString = EMPTY_BYTES,
    options?: ExecuteCommandOptions
  ): Promise<ShellCommandResult> {
    const previousShellPid = this.activeShellPid;
    if (shellPid !== undefined) this.activeShellPid = shellPid;
    const teeId = options?.onOutput ? `tee-${(this.nextOutputTeeId += 1)}` : undefined;
    if (teeId && options?.onOutput) this.outputTees.set(teeId, options.onOutput);
    try {
      // `shellPid` also rides this run's env, so a run that outlives the call
      // (the bash tool's detached jobs) still parents its realm children
      // correctly once `activeShellPid` has moved on to a later command.
      const result = await this.runCommand(
        command,
        signal,
        shellPid,
        stdin,
        teeId,
        options?.capturePipeStatus
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...(result.pipeStatus !== undefined ? { pipeStatus: result.pipeStatus } : {}),
      };
    } finally {
      this.activeShellPid = previousShellPid;
      if (teeId) this.outputTees.delete(teeId);
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
        exec: (cmd, opts) =>
          this.bash.exec(cmd, {
            env: opts?.env ?? this.lastEnv,
            cwd: opts?.cwd ?? this.cwd,
            umask: this.umask,
            ...(opts?.env !== undefined ? { replaceEnv: true } : {}),
          }),
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
        umask: this.umask,
      });
      // A profile's `umask 077` is the classic case for carrying the mask.
      if (typeof result.umask === 'number') this.umask = result.umask;
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
    stdin: ByteString = EMPTY_BYTES,
    outputTeeId?: string,
    capturePipeStatus = false
  ): Promise<BashExecResult & { pipeStatus?: number[] }> {
    const commandName = command.trim().split(/\s+/)[0] || 'unknown';
    emitShellCommand(commandName);

    // A file read answers for a request body only inside the command that read
    // it (`curl -d @file` reads and fetches in one command). Dropping the
    // previous command's reads here is what keeps the string key from matching
    // an unrelated later body — see `request-body-provenance.ts`.
    clearReadByteProvenance();

    // Wait for the constructor's `.jsh` registration before the first command.
    // (Also before GNU bash: its PATH search finds `.jsh` commands too.)
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
    if (await this.gnuBashFallback.usesGnuBash()) {
      return this.gnuBashFallback.runOnGnuBash(
        command,
        signal,
        runPid,
        stdin,
        outputTeeId,
        capturePipeStatus
      );
    }

    // just-bash's published ExecOptions type does not yet expose
    // AbortSignal, but we still forward it so external callers and
    // terminal Ctrl+C keep a consistent cancellation path.
    // A script that opens with a comment explains itself; carry that text on
    // the run so a sudo prompt raised mid-dispatch can show the approver WHY,
    // not just what. Per-run env (not shell state) so concurrent runs on one
    // shell never borrow each other's reason — see `SUDO_REASON_ENV`.
    const sudoReason = extractLeadingCommentReason(command);
    const taggedEnv: Record<string, string> = {
      ...this.lastEnv,
      ...(runPid === undefined ? {} : { [RUN_PID_ENV]: String(runPid) }),
      ...(outputTeeId === undefined ? {} : { [OUTPUT_TEE_ENV]: outputTeeId }),
      ...(sudoReason ? { [SUDO_REASON_ENV]: sudoReason } : {}),
    };
    const execOptions: BashExecOptionsWithSignal = {
      // Tagged per run so realm-backed commands can recover THIS run's parent
      // pid from their own `ctx.env` under concurrency (see `RUN_PID_ENV`).
      env: taggedEnv,
      cwd: this.cwd,
      umask: this.umask,
      signal,
      ...(stdin !== EMPTY_BYTES
        ? { stdin: stdin as unknown as string, stdinKind: 'bytes' as const }
        : {}),
    };
    const pathBeforeExec = this.lastEnv.PATH;
    const linked = linkAbort([signal, this.commandAbort.signal]);
    execOptions.signal = linked.signal;
    this.activeRunSignal = linked.signal;
    const scriptRun = this.beginScriptRun(command);
    let result: BashExecResult & { pipeStatus?: number[] };
    try {
      result = await this.bash.exec(
        scriptForPipeStatusCapture(command, capturePipeStatus),
        execOptions
      );
    } finally {
      linked.release();
      if (this.activeRunSignal === linked.signal) this.activeRunSignal = undefined;
      this.endScriptRun(scriptRun);
    }
    // Persist any "Always" command grants confirmed during dispatch now that we
    // are outside just-bash's execution box (where VFS async timers are blocked).
    await this.commandGate.flushPendingCommandGrants();
    result = applyCapturedPipeStatus(result, capturePipeStatus);
    if (typeof result.umask === 'number') this.umask = result.umask;
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
    // `$NAME`. A `null` is a removal: `result.env` DOES still carry the old
    // value, so it has to be deleted after the overwrite or it comes back.
    this.applyPendingEnvWrites();
    if (result.env?.PWD) {
      this.cwd = result.env.PWD;
    }

    if (result.exitCode === 127) {
      const jshResult = await this.jshRegistry.tryJshFallback(command, runPid);
      if (jshResult) {
        void this.syncJshCommands().catch(() => undefined);
        return jshResult;
      }
    }

    if (result.exitCode !== 0 && result.stderr.includes('Permission denied')) {
      const { withShebangExecHint } = await import('./shebang-exec-hint.js');
      return attachPipeStatus(
        await withShebangExecHint(result, this.cwd, this.vfsAdapter),
        result.pipeStatus
      );
    }
    return result;
  }

  private applyPendingEnvWrites(): void {
    for (const [k, v] of this.pendingEnvWrites) {
      if (v === null) delete this.lastEnv[k];
      else this.lastEnv[k] = v;
    }
    this.pendingEnvWrites.clear();
  }

  /**
   * The command policy for a program a wasm process runs natively (`NativeGate`):
   * what just-bash's registry filter and dispatch-time sudo gate do for a command.
   */
  private readonly gateNativeCommand = async (
    name: string,
    args: string[],
    env: Record<string, string>
  ): Promise<{ stderr: string; exitCode: number } | null> => {
    if (this.allowedCommands !== null && !this.isCommandAllowed(name)) {
      return { stderr: `bash: ${name}: command not found\n`, exitCode: 127 };
    }
    // Plumbing runs inside a call of its command, which the gate already saw.
    if (!this.commandGate.isTransparentGatingEnabled() || PLUMBING.has(name)) return null;
    const denial = await this.commandGate.gateCommandDispatch(name, args, env[SUDO_REASON_ENV]);
    return denial ? { stderr: denial.stderr, exitCode: denial.exitCode } : null;
  };

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Dispatch-time decorators for a registry entry: sudo gate inside, progress
   * start/end outside. Every command registered after construction (`.jsh`,
   * workflows) must go through this too.
   */
  private wrapCommandForDispatch(command: Command): Command {
    const inner = this.commandGate.wrapCommandForSudo(command);
    const wrapped =
      command.name === 'timeout'
        ? wrapTimeoutForProgress(inner, this.progress)
        : wrapCommandForProgress(inner, this.progress);
    const onSettled = () => this.scriptRun?.stepDone();
    const teeOutput = (env: ReadonlyMap<string, string> | undefined, result: ExecResult) =>
      this.teeCommandOutput(env, result);
    const outputTees = this.outputTees;
    return {
      ...wrapped,
      async execute(args, ctx) {
        // Step counting seam: every registry dispatch, including the ones
        // `wrapCommandForProgress` skips (`echo`, …). Counted on COMPLETION so
        // the script bar advances when a step finishes, not when it starts.
        // O(1) when no script unit is active.
        const teeId = ctx.env?.get(OUTPUT_TEE_ENV);
        const tee = teeId ? outputTees.get(teeId) : undefined;
        if (tee) {
          (ctx as CommandContext & { writeStdout?: (chunk: string) => void }).writeStdout = tee;
        }
        try {
          // Settled on abort, so a slow one cannot poison its caller's scope.
          const result = await settleOnAbort(() => wrapped.execute(args, ctx), ctx.signal);
          // Incremental tee for the agent bash tool (#2415): emit each
          // command's output as it settles so a later timeout kill still has
          // the pre-kill payload on disk. Commands that already streamed via
          // `writeStdout` (e.g. `jshd logs -f`) return empty stdout so this
          // is a no-op.
          teeOutput(ctx.env, result);
          return result;
        } finally {
          onSettled();
        }
      },
    };
  }

  /**
   * Forward a settled command's stdout+stderr to the run's optional output tee.
   * No-op when the run did not request one (human terminal, most tool calls).
   */
  private teeCommandOutput(
    env: ReadonlyMap<string, string> | undefined,
    result: { stdout?: string; stderr?: string }
  ): void {
    const teeId = env?.get(OUTPUT_TEE_ENV);
    if (!teeId) return;
    const tee = this.outputTees.get(teeId);
    if (!tee) return;
    const chunk = [result.stdout, result.stderr].filter(Boolean).join('');
    if (chunk) tee(chunk);
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

  /**
   * True when `name` is registrable/executable under the allow-list. Plumbing
   * (`git-credential-slicc`) is allowed exactly when its command is.
   */
  private isCommandAllowed(name: string): boolean {
    return this.allowedCommands === null || this.allowedCommands.has(PLUMBING.get(name) ?? name);
  }

  private createGitCustomCommand(): Command {
    const gitCommands = this.gitCommands;
    return defineCommand('git', async (args, ctx) => {
      const cwd = ctx.cwd;
      const result = await gitCommands.execute(args, cwd, ctx.env, stdinAsText(ctx.stdin));
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

  /**
   * `umount <path>` — the muscle-memory alias for `mount unmount <path>`
   * (issue #2738). Registered as its own top-level command so `commands`,
   * `which`, and tab completion list it like any other builtin.
   */
  private createUmountCustomCommand(): Command {
    const mountCommands = this.mountCommands;
    return defineCommand('umount', async (args, ctx) => {
      const cwd = ctx.cwd;
      const result = await mountCommands.executeUmount(args, cwd);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
  }

  async getWorkflowCommandNames(): Promise<string[]> {
    return this.jshRegistry.getWorkflowCommandNames();
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
