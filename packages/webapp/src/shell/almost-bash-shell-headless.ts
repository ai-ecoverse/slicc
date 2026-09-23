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
import { filesystemExecutionLimits } from './filesystem-budgets.js';
import { DEFAULT_HOME_DIR, resolveHomeDir, userFromHome } from './home-dir.js';
import { DEFAULT_SHELL_PATH, type JshDiscoveryFS, pathToScanRoots } from './jsh-discovery.js';
import type { JshProcessConfig } from './jsh-executor.js';
import { executeJsCode, executeJshFile } from './jsh-executor.js';
import { EMPTY_BYTES, stdinAsText } from './just-bash-compat.js';
import { parseShellArgs } from './parse-shell-args.js';
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
import { ScriptCatalog } from './script-catalog.js';
import { commandSudoSubject, enforceCommandSudo } from './sudo/command-guard.js';
import { extractLeadingCommentReason, SUDO_REASON_ENV } from './sudo/command-reason.js';
import { runMountDirectoryApproval } from './supplemental-commands/mount-directory-approval.js';
import { sayStdioPlugin } from './supplemental-commands/say-stdio-rewrite.js';
import { createSkillCommand, createUpskillCommand } from './supplemental-commands/upskill/index.js';
import type { MediaPreviewItem } from './supplemental-commands.js';
import { createSupplementalCommands } from './supplemental-commands.js';
import { emitShellCommand } from './telemetry-hook.js';
import { VfsAdapter } from './vfs-adapter.js';
import { buildWorkflowRunArgv, type WorkflowCommandEntry } from './workflow-discovery.js';

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

  getCurrentShellPid?: () => number | undefined;

  sudo?: ShellSudoConfig;

  scrubProgressLabel?: (text: string) => Promise<string>;

  executionLimitProfile?: NonNullable<
    ConstructorParameters<typeof Bash>[0]
  >['executionLimitProfile'];

  executionLimits?: NonNullable<ConstructorParameters<typeof Bash>[0]>['executionLimits'];
}

export interface ShellSudoConfig {
  getPolicy: () => SudoersPolicy | null;

  broker: SudoBroker;

  persistCommandGrant?: (pattern: string) => Promise<void>;

  transparentGating?: boolean;

  defaultDisposition?: import('../base/sudoers.js').DefaultDisposition;
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

async function ensureFreshGithubToken(opts?: { force?: boolean }): Promise<void> {
  const github = getRegisteredProviderConfig('github');
  if (!github) return;
  if (opts?.force) {
    await github.onSilentRenew?.();
    return;
  }
  await github.getValidAccessToken?.();
}

type BashExecOptionsWithSignal = NonNullable<Parameters<Bash['exec']>[1]> & {
  signal?: AbortSignal;
};

const log = createLogger('almost-bash-shell');

const RUN_PID_ENV = '__SLICC_RUN_PID';

const OUTPUT_TEE_ENV = '__SLICC_OUTPUT_TEE__';

function runPidFromEnv(runEnv?: ReadonlyMap<string, string>): number | undefined {
  const raw = runEnv?.get(RUN_PID_ENV);
  if (raw === undefined) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

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

export class AlmostBashShellHeadless implements HeadlessShellLike {
  protected bash: Bash;
  protected vfsAdapter: VfsAdapter;
  protected gitCommands: GitCommands;
  protected mountCommands: MountCommands;

  protected lastEnv: Record<string, string>;
  protected cwd: string;

  protected builtinCommandNames: Set<string>;

  protected readonly staticBuiltinNames: Set<string>;

  protected readonly allowedCommands: ReadonlySet<string> | null;
  protected readonly scriptCatalog: ScriptCatalog;

  private initialJshSync: Promise<void> | null = null;
  protected readonly ownsScriptCatalog: boolean;

  protected registeredJshCommands = new Map<string, string>();

  protected registeredWorkflowCommands = new Set<string>();

  private jshSyncInflight: Promise<void> | null = null;

  private jshSyncDirty = false;

  private pendingCommandGrants: string[] = [];

  private pendingSudoBypasses = new Map<string, number>();

  private pendingEnvWrites = new Map<string, string | null>();

  private activeShellPid: number | undefined;

  private readonly progress: ProgressEmitter;

  private activeRunSignal: AbortSignal | undefined;

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

      getScriptRegisteredNames: () => [
        ...this.registeredJshCommands.keys(),
        ...this.registeredWorkflowCommands,
      ],
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

      processManager: options.processManager,

      sudoCommand: options.sudo
        ? {
            broker: options.sudo.broker,

            persistGrant: async (pattern) => {
              this.pendingCommandGrants.push(pattern);
            },
            suppressNextGate: (subject) => this.registerSudoBypass(subject),
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

    this.lastEnv = { ...initialEnv };
    this.cwd = initialCwd;

    this.startInitialJshSync();
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
    return [...(await this.getFilteredJshCommands()).keys()];
  }

  async syncJshCommands(): Promise<void> {
    if (this.jshSyncInflight !== null) {
      this.jshSyncDirty = true;
      return this.jshSyncInflight;
    }
    this.jshSyncInflight = this.doSyncJshCommands();
    return this.jshSyncInflight;
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
      });
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
      signal,
      ...(stdin !== EMPTY_BYTES
        ? { stdin: stdin as unknown as string, stdinKind: 'bytes' as const }
        : {}),
    };
    const pathBeforeExec = this.lastEnv.PATH;
    this.activeRunSignal = signal;
    const scriptRun = this.beginScriptRun(command);
    let result: BashExecResult & { pipeStatus?: number[] };
    try {
      result = await this.bash.exec(
        scriptForPipeStatusCapture(command, capturePipeStatus),
        execOptions
      );
    } finally {
      if (this.activeRunSignal === signal) this.activeRunSignal = undefined;
      this.endScriptRun(scriptRun);
    }

    await this.flushPendingCommandGrants();
    result = applyCapturedPipeStatus(result, capturePipeStatus);
    if (result.env) {
      this.lastEnv = stripRunPid(result.env);
    }

    if (result.env && this.lastEnv.PATH !== pathBeforeExec) {
      await this.syncJshCommands().catch(() => undefined);
    }

    if (this.pendingEnvWrites.size > 0) {
      for (const [k, v] of this.pendingEnvWrites) {
        if (v === null) {
          delete this.lastEnv[k];
        } else {
          this.lastEnv[k] = v;
        }
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

    if (result.exitCode !== 0 && result.stderr.includes('Permission denied')) {
      const { withShebangExecHint } = await import('./shebang-exec-hint.js');
      return attachPipeStatus(
        await withShebangExecHint(result, this.cwd, this.vfsAdapter),
        result.pipeStatus
      );
    }
    return result;
  }

  private isTransparentGatingEnabled(): boolean {
    const sudo = this.options.sudo;
    return !!sudo && sudo.transparentGating !== false;
  }

  private wrapCommandForDispatch(command: Command): Command {
    const inner = this.wrapCommandForSudo(command);
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
          const result = await wrapped.execute(args, ctx);

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

  private wrapCommandForSudo(command: Command): Command {
    if (!this.isTransparentGatingEnabled()) return command;
    const guard = (args: string[], reason?: string) =>
      this.gateCommandDispatch(command.name, args, reason);
    return {
      ...command,
      async execute(args: string[], ctx: ResolvedCommandContext): Promise<ExecResult> {
        const denial = await guard(args, ctx.env?.get(SUDO_REASON_ENV));
        if (denial) return denial;
        return command.execute(args, ctx);
      },
    };
  }

  private async gateCommandDispatch(
    name: string,
    args: string[],
    reason?: string
  ): Promise<ExecResult | null> {
    const sudo = this.options.sudo;
    if (!sudo) return null;

    const subject = commandSudoSubject(name, args);

    if (this.consumeSudoBypass(subject)) {
      return null;
    }

    const policy = sudo.getPolicy();
    if (!policy) return null;

    const result = await enforceCommandSudo(subject, {
      policy,
      broker: sudo.broker,

      persistGrant: async (pattern) => {
        this.pendingCommandGrants.push(pattern);
      },
      defaultDisposition: sudo.defaultDisposition,
      ...(reason ? { reason } : {}),
    });
    if (result.allowed) return null;

    return {
      stdout: '',
      stderr: `${result.message}\n`,
      exitCode: 1,
    };
  }

  private registerSudoBypass(subject: string): void {
    const key = subject.trim();
    if (!key) return;
    this.pendingSudoBypasses.set(key, (this.pendingSudoBypasses.get(key) ?? 0) + 1);
  }

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

  private async flushPendingCommandGrants(): Promise<void> {
    if (this.pendingCommandGrants.length === 0) return;
    const grants = this.pendingCommandGrants;
    this.pendingCommandGrants = [];
    for (const pattern of grants) {
      try {
        await this.persistCommandGrant(pattern);
      } catch {}
    }
  }

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

  private isCommandAllowed(name: string): boolean {
    return this.allowedCommands === null || this.allowedCommands.has(name);
  }

  private async doSyncJshCommands(): Promise<void> {
    try {
      const jshIndex = await this.scriptCatalog.getJshIndex(this.currentScanRoots());
      const jshMap = jshIndex.commands;
      for (const collision of jshIndex.collisions) {
        log.warn(
          `jsh command '${collision.name}' is provided by more than one skill; using ${collision.winnerPath} (${collision.reason}), shadowed ${collision.shadowedPaths.join(', ')}`
        );
      }
      const wfMap = await this.getFilteredWorkflowCommands();

      for (const [name, scriptPath] of jshMap) {
        if (!this.isCommandAllowed(name)) continue;
        if (this.builtinCommandNames.has(name) && !this.registeredJshCommands.has(name)) continue;
        if (this.registeredJshCommands.get(name) === scriptPath) continue;
        this.bash.registerCommand(this.wrapCommandForDispatch(this.makeScriptCommand(name)));
        this.registeredJshCommands.set(name, scriptPath);
        this.builtinCommandNames.add(name);
      }

      for (const name of wfMap.keys()) {
        if (this.registeredWorkflowCommands.has(name)) continue;
        if (this.registeredJshCommands.has(name)) {
          this.registeredWorkflowCommands.add(name);
          continue;
        }
        if (this.builtinCommandNames.has(name)) continue;
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

  private makeScriptCommand(name: string): Command {
    const catalog = this.scriptCatalog;
    const discoveryFs = this.options.jshDiscoveryFs ?? this.options.fs;
    const cmdName = name;
    const executeInner = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
      const execFn: typeof ctx.exec =
        ctx.exec ??
        ((cmd, opts) =>
          this.bash.exec(cmd, {
            env: opts?.env ?? Object.fromEntries(ctx.env),
            cwd: opts?.cwd ?? ctx.cwd,
            args: opts?.args,
            ...(opts?.env !== undefined ? { replaceEnv: true } : {}),
          }));

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

      const wfMap = await catalog.getWorkflowCommands();
      const wf = wfMap.get(cmdName);
      if (wf) {
        const argv = buildWorkflowRunArgv(wf.path, args);
        return execFn(argv[0], { args: argv.slice(1), cwd: ctx.cwd });
      }

      return { stdout: '', stderr: `${cmdName}: command no longer exists\n`, exitCode: 127 };
    };
    return {
      name,

      trusted: true,
      async execute(args: string[], ctx) {
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
        exec: (cmd, opts) =>
          this.bash.exec(cmd, {
            env: opts?.env ?? this.lastEnv,
            cwd: opts?.cwd ?? this.cwd,
            ...(opts?.env !== undefined ? { replaceEnv: true } : {}),
          }),
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

  protected buildJshProcessConfig(runPid?: number): JshProcessConfig | undefined {
    if (!this.options.processManager || !this.options.processOwner) return undefined;
    return {
      processManager: this.options.processManager,
      owner: this.options.processOwner,

      getParentPid: () => runPid ?? this.activeShellPid ?? this.options.getCurrentShellPid?.(),
    };
  }
}
