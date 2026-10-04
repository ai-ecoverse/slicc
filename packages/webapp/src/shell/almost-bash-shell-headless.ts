import type {
  BashExecResult,
  ByteString,
  Command,
  CommandContext,
  CommandName,
  ExecResult,
} from 'just-bash';
import { Bash, defineCommand, getCommandNames, getNetworkCommandNames } from 'just-bash';

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

export interface HeadlessShellOptions {
  fs: VirtualFS;

  cwd?: string;

  env?: Record<string, string>;

  browserAPI?: BrowserAPI;

  webhook?: SupplementalCommandsConfig['webhook'];

  crontask?: SupplementalCommandsConfig['crontask'];

  jshDiscoveryFs?: JshDiscoveryFS;

  bshDiscoveryFs?: BshDiscoveryFS;

  scriptCatalog?: ScriptCatalog;

  allowedCommands?: readonly string[];

  getParentJid?: () => string | undefined;

  isScoop?: () => boolean;

  processManager?: ProcessManager;

  processOwner?: ProcessOwner;

  terminal?: TerminalPort;

  gnuBash?: boolean;

  getCurrentShellPid?: () => number | undefined;

  sudo?: ShellSudoConfig;

  scrubProgressLabel?: (text: string) => Promise<string>;

  mcpConnectionManager?: SupplementalCommandsConfig['mcpConnectionManager'];

  executionLimitProfile?: NonNullable<
    ConstructorParameters<typeof Bash>[0]
  >['executionLimitProfile'];

  executionLimits?: NonNullable<ConstructorParameters<typeof Bash>[0]>['executionLimits'];
}

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

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;

  pipeStatus?: number[];
}

export interface ExecuteCommandOptions {
  onOutput?: (chunk: string) => void;

  capturePipeStatus?: boolean;
}

export type { BashExecResult };

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

const log = createLogger('almost-bash-shell');

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

  protected lastEnv: Record<string, string>;
  protected cwd: string;

  protected umask = 0o022;

  protected builtinCommandNames: Set<string>;

  protected readonly staticBuiltinNames: Set<string>;

  protected readonly allowedCommands: ReadonlySet<string> | null;
  protected readonly scriptCatalog: ScriptCatalog;

  private initialJshSync: Promise<void> | null = null;
  protected readonly ownsScriptCatalog: boolean;
  private readonly commandGate: CommandGate;
  private jshRegistry!: JshCommandRegistry;
  private gnuBashFallback!: GnuBashFallback;

  private pendingEnvWrites = new Map<string, string | null>();

  private activeShellPid: number | undefined;

  private readonly progress: ProgressEmitter;

  private activeRunSignal: AbortSignal | undefined;

  private commandAbort = new AbortController();

  private scriptRun: ScriptRun | null = null;
  private scriptRunsActive = 0;

  private registryNames: ReadonlySet<string> = new Set();

  private readonly outputTees = new Map<string, (chunk: string) => void>();
  private nextOutputTeeId = 0;

  private readonly resolveJshProcessConfig = (
    runEnv?: ReadonlyMap<string, string>
  ): JshProcessConfig | undefined => this.buildJshProcessConfig(runPidFromEnv(runEnv));

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

  private static buildInitialEnv(
    options: HeadlessShellOptions,
    initialCwd: string
  ): Record<string, string> {
    return {
      HOME: DEFAULT_HOME_DIR,
      PATH: DEFAULT_SHELL_PATH,
      USER: 'user',
      SHELL: '/bin/bash',

      TMPDIR: '/tmp',
      PWD: initialCwd,
      ...options.env,
    };
  }

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

      processManager: options.processManager,

      sudoCommand: options.sudo
        ? {
            broker: options.sudo.broker,

            persistGrant: async (pattern) => {
              this.commandGate.queueGrant(pattern);
            },
            suppressNextGate: (subject) => this.commandGate.registerSudoBypass(subject),
          }
        : undefined,

      setEnv: (name, value) => {
        this.pendingEnvWrites.set(name, value);
        this.lastEnv[name] = value;
      },

      unsetEnv: (name) => {
        this.pendingEnvWrites.set(name, null);
        delete this.lastEnv[name];
      },

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

      env: {},
      fetch: fetchFn,
      commands: allowedBuiltinNames,
      customCommands,

      sleep: makeSleepWithProgress(this.progress, {
        isAborted: () => this.activeRunSignal?.aborted ?? false,
      }),
      executionLimitProfile: options.executionLimitProfile,
      executionLimits: filesystemExecutionLimits(
        options.isScoop?.() ?? false,
        options.executionLimits
      ),
    });

    this.bash.registerTransformPlugin(sayStdioPlugin);

    if (this.allowedCommands !== null) {
      const bashInternals = this.bash as unknown as { commands: Map<string, unknown> };
      for (const name of getNetworkCommandNames()) {
        if (!this.isCommandAllowed(name)) {
          bashInternals.commands.delete(name);
        }
      }
    }

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
    this.staticBuiltinNames = new Set(this.builtinCommandNames);
    this.vfsAdapter.setRegisteredCommandsFn(() => [...this.builtinCommandNames]);

    this.vfsAdapter.setIdentityFn(() => ({
      user: this.lastEnv.USER ?? 'user',
      home: this.lastEnv.HOME ?? DEFAULT_HOME_DIR,
    }));

    this.lastEnv = { ...initialEnv };
    this.cwd = initialCwd;
    this.bindCollaborators(options);

    this.startInitialJshSync();
  }

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

  getBash(): Bash {
    return this.bash;
  }

  getCwd(): string {
    return this.cwd;
  }

  getScriptCatalog(): ScriptCatalog {
    return this.scriptCatalog;
  }

  getEnv(): Record<string, string> {
    return { ...this.lastEnv };
  }

  setMaskedEnvVar(name: string, maskedValue: string): void {
    this.pendingEnvWrites.set(name, maskedValue);
    this.lastEnv[name] = maskedValue;
  }

  applySessionOverrides(options: { cwd?: string; env?: Record<string, string> }): void {
    if (options.cwd !== undefined) {
      this.cwd = options.cwd;
      this.lastEnv.PWD = options.cwd;
    }
    if (options.env) Object.assign(this.lastEnv, options.env);
  }

  async getJshCommandNames(): Promise<string[]> {
    return this.jshRegistry.getJshCommandNames();
  }

  async syncJshCommands(): Promise<void> {
    return this.jshRegistry.syncJshCommands();
  }

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

  dispose(): void {
    if (this.ownsScriptCatalog) {
      this.scriptCatalog.dispose();
    }
  }

  protected async renderMediaPreview(_items: MediaPreviewItem[]): Promise<void> {
    throw new Error('terminal preview is unavailable in headless mode');
  }

  private startInitialJshSync(): void {
    this.initialJshSync = this.initHomeAndProfile()
      .then(() => this.syncJshCommands())
      .catch(() => undefined)
      .finally(() => {
        this.initialJshSync = null;
      });
  }

  private async initHomeAndProfile(): Promise<void> {
    const fs = this.options.fs;
    try {
      const pinnedHome = this.options.env?.HOME;
      const home = pinnedHome ?? (await resolveHomeDir(fs));
      this.lastEnv.HOME = home;
      if (!this.options.env?.USER) {
        this.lastEnv.USER = userFromHome(home);
      }

      const profilePath = `${home.replace(/\/+$/, '')}/.profile`;
      if (!(await fs.exists(profilePath).catch(() => false))) return;

      const result = await this.bash.exec(`. "$HOME/.profile"`, {
        env: this.lastEnv,
        cwd: this.cwd,
        umask: this.umask,
      });

      if (typeof result.umask === 'number') this.umask = result.umask;
      if (result.env) {
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

    clearReadByteProvenance();

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

    const sudoReason = extractLeadingCommentReason(command);
    const taggedEnv: Record<string, string> = {
      ...this.lastEnv,
      ...(runPid === undefined ? {} : { [RUN_PID_ENV]: String(runPid) }),
      ...(outputTeeId === undefined ? {} : { [OUTPUT_TEE_ENV]: outputTeeId }),
      ...(sudoReason ? { [SUDO_REASON_ENV]: sudoReason } : {}),
    };
    const execOptions: BashExecOptionsWithSignal = {
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

    await this.commandGate.flushPendingCommandGrants();
    result = applyCapturedPipeStatus(result, capturePipeStatus);
    if (typeof result.umask === 'number') this.umask = result.umask;
    if (result.env) {
      this.lastEnv = stripRunPid(result.env);
    }

    if (result.env && this.lastEnv.PATH !== pathBeforeExec) {
      await this.syncJshCommands().catch(() => undefined);
    }

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

  private readonly gateNativeCommand = async (
    name: string,
    args: string[],
    env: Record<string, string>
  ): Promise<{ stderr: string; exitCode: number } | null> => {
    if (this.allowedCommands !== null && !this.isCommandAllowed(name)) {
      return { stderr: `bash: ${name}: command not found\n`, exitCode: 127 };
    }

    if (!this.commandGate.isTransparentGatingEnabled() || PLUMBING.has(name)) return null;
    const denial = await this.commandGate.gateCommandDispatch(name, args, env[SUDO_REASON_ENV]);
    return denial ? { stderr: denial.stderr, exitCode: denial.exitCode } : null;
  };

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
        const teeId = ctx.env?.get(OUTPUT_TEE_ENV);
        const tee = teeId ? outputTees.get(teeId) : undefined;
        if (tee) {
          (ctx as CommandContext & { writeStdout?: (chunk: string) => void }).writeStdout = tee;
        }
        try {
          const result = await settleOnAbort(() => wrapped.execute(args, ctx), ctx.signal);

          teeOutput(ctx.env, result);
          return result;
        } finally {
          onSettled();
        }
      },
    };
  }

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

  private beginScriptRun(command: string): ScriptRun | null {
    this.scriptRunsActive += 1;
    if (!this.progress.hasSink()) return null;
    if (this.scriptRunsActive > 1) {
      this.scriptRun?.end();
      this.scriptRun = null;
      return null;
    }

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

  protected buildJshProcessConfig(runPid?: number): JshProcessConfig | undefined {
    if (!this.options.processManager || !this.options.processOwner) return undefined;
    return {
      processManager: this.options.processManager,
      owner: this.options.processOwner,

      getParentPid: () => runPid ?? this.activeShellPid ?? this.options.getCurrentShellPid?.(),
    };
  }
}
