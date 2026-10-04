/**
 * Discovery and late registration of `.jsh`, wasm-program, and workflow
 * commands on a just-bash registry.
 *
 * just-bash has no unregister: names that leave `$PATH` stay registered and
 * dispatch 127. Sync coalesces in-flight scans; a dirty flag re-runs after.
 */

import type { Bash, BashExecResult, Command, CommandContext, ExecResult } from 'just-bash';
import { createLogger } from '../base/logger.js';
import type { JshDiscoveryFS } from './jsh-discovery.js';
import { pathToScanRoots } from './jsh-discovery.js';
import type { JshProcessConfig } from './jsh-executor.js';
import { executeJsCode } from './jsh-executor.js';
import { EMPTY_BYTES } from './just-bash-compat.js';
import { parseShellArgs } from './parse-shell-args.js';
import { runPidFromEnv } from './run-env.js';
import type { ScriptCatalog } from './script-catalog.js';
import type { NativeGate } from './supplemental-commands/wasm/launch.js';
import { buildWorkflowRunArgv, type WorkflowCommandEntry } from './workflow-discovery.js';

const log = createLogger('almost-bash-shell');

export interface JshCommandRegistryHost {
  bash: Bash;
  scriptCatalog: ScriptCatalog;
  discoveryFs: JshDiscoveryFS;
  vfsAdapter: CommandContext['fs'];
  cwd: string;
  lastEnv: Record<string, string>;
  umask: number;
  builtinCommandNames: Set<string>;
  isCommandAllowed: (name: string) => boolean;
  wrapCommandForDispatch: (command: Command) => Command;
  path: () => string;
  buildJshProcessConfig: (runPid?: number) => JshProcessConfig | undefined;
  gateNativeCommand: NativeGate;
  gitIdentity: () => Promise<{ name: string; email: string }>;
}

export class JshCommandRegistry {
  /** Maps .jsh command names to their registered script paths. */
  readonly registeredJshCommands = new Map<string, string>();
  /** Workflow command names we've registered (handler is dynamic, so a Set suffices). */
  readonly registeredWorkflowCommands = new Set<string>();
  /** Wasm-program command names of installed packages we've registered (#3530). */
  readonly registeredWasmCommands = new Set<string>();
  /** Promise for the currently in-flight jsh sync. */
  private jshSyncInflight: Promise<void> | null = null;
  /** Re-sync requested while one was already in flight. */
  private jshSyncDirty = false;

  constructor(private readonly host: JshCommandRegistryHost) {}

  /** Names that entered the registry via script registration (.jsh / workflow / wasm). */
  scriptRegisteredNames(): string[] {
    return [
      ...this.registeredJshCommands.keys(),
      ...this.registeredWorkflowCommands,
      ...this.registeredWasmCommands,
    ];
  }

  scanRoots(): string[] {
    return pathToScanRoots(this.host.path());
  }

  /** Currently discovered `.jsh` command names (filtered by allow-list). */
  async getJshCommandNames(): Promise<string[]> {
    return [...(await this.getFilteredJshCommands()).keys()];
  }

  async getWorkflowCommandNames(): Promise<string[]> {
    return [...(await this.getFilteredWorkflowCommands()).keys()];
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

  async getFilteredJshCommands(): Promise<Map<string, string>> {
    const all = await this.host.scriptCatalog.getJshCommands(this.scanRoots());
    const filtered = new Map<string, string>();
    for (const [name, path] of all) {
      if (this.host.builtinCommandNames.has(name)) continue;
      if (!this.host.isCommandAllowed(name)) continue;
      filtered.set(name, path);
    }
    return filtered;
  }

  async getFilteredWorkflowCommands(): Promise<Map<string, WorkflowCommandEntry>> {
    const all = await this.host.scriptCatalog.getWorkflowCommands();
    const filtered = new Map<string, WorkflowCommandEntry>();
    for (const [name, entry] of all) {
      if (!this.host.isCommandAllowed(name)) continue;
      filtered.set(name, entry);
    }
    return filtered;
  }

  /**
   * `.jsh` fallback when bash returns 127.
   *
   * `runPid` is the originating run's parent pid — passed straight down (we are
   * still in that run's own frame here) so a `.jsh` reached through the fallback
   * parents its realm child to the job that ran it, not to whichever concurrent
   * run happens to be active.
   */
  async tryJshFallback(command: string, runPid?: number): Promise<BashExecResult | null> {
    const trimmed = command.trim();
    const firstSpace = trimmed.indexOf(' ');
    const cmdName = firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed;
    const argsStr = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : '';

    const jshMap = await this.getFilteredJshCommands();
    const scriptPath = jshMap.get(cmdName);
    if (!scriptPath) return null;

    const args = argsStr ? parseShellArgs(argsStr) : [];

    let code: string;
    try {
      const raw = await this.host.discoveryFs.readFile(scriptPath, { encoding: 'utf-8' });
      code = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch {
      return {
        stdout: '',
        stderr: `jsh: cannot read script '${scriptPath}'\n`,
        exitCode: 127,
        env: this.host.lastEnv,
      };
    }

    const argv = ['node', scriptPath, ...args];
    const result = await executeJsCode(
      code,
      argv,
      {
        fs: this.host.vfsAdapter,
        cwd: this.host.cwd,
        env: new Map(Object.entries(this.host.lastEnv)),
        stdin: EMPTY_BYTES,
        exec: (cmd, opts) =>
          this.host.bash.exec(cmd, {
            env: opts?.env ?? this.host.lastEnv,
            cwd: opts?.cwd ?? this.host.cwd,
            umask: this.host.umask,
            ...(opts?.env !== undefined ? { replaceEnv: true } : {}),
          }),
      },
      this.host.buildJshProcessConfig(runPid)
    );

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      env: this.host.lastEnv,
    };
  }

  /**
   * One late-binding handler per script-command name. Resolves precedence at DISPATCH
   * against current VFS state: built-in > .jsh > installed wasm program > saved-workflow.
   * (just-bash has no unregister, so we never rebuild the table — the handler reads live
   * discovery each call.)
   */
  makeScriptCommand(name: string): Command {
    const host = this.host;
    const catalog = host.scriptCatalog;
    const discoveryFs = host.discoveryFs;
    const cmdName = name;
    const executeInner = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
      const execFn: typeof ctx.exec =
        ctx.exec ??
        ((cmd, opts) =>
          // Forward `args` — the workflow branch passes the `workflow run …` argv via
          // opts.args; dropping it would run a bare `workflow` (just-bash's Bash.exec
          // appends opts.args to the command).
          host.bash.exec(cmd, {
            env: opts?.env ?? Object.fromEntries(ctx.env),
            cwd: opts?.cwd ?? ctx.cwd,
            args: opts?.args,
            ...(opts?.env !== undefined ? { replaceEnv: true } : {}),
          }));

      // 1) .jsh wins the bare name.
      const jshMap = await catalog.getJshCommands(this.scanRoots());
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
          host.buildJshProcessConfig(runPidFromEnv(ctx.env))
        );
      }

      // 2) Else a wasm program of an installed package (#3530).
      const wasm = (await catalog.getWasmCommands()).get(cmdName);
      if (wasm) {
        const { runWasmCommand } = await import('./supplemental-commands/wasm/run.js');
        return runWasmCommand(
          // A script command runs by name: `wasm` hands it to its interpreter.
          wasm.script
            ? [cmdName, ...args]
            : [
                '--argv0',
                wasm.argv0,
                '--module',
                wasm.wasm,
                wasm.glue,
                ...(wasm.args ?? []),
                ...args,
              ],
          ctx,
          {
            processConfig: host.buildJshProcessConfig(runPidFromEnv(ctx.env)),
            gate: host.gateNativeCommand,
            defaults: wasm.env,
            commands: () => catalog.getWasmCommands(),
            gitIdentity: () => host.gitIdentity(),
          }
        );
      }

      // 3) Else a workflow (saved bare or skill <skill>:<name>) — route through the
      //    `workflow run` command path (NOT executeJsCode on the raw file).
      const wfMap = await catalog.getWorkflowCommands();
      const wf = wfMap.get(cmdName);
      if (wf) {
        const argv = buildWorkflowRunArgv(wf.path, args);
        return execFn(argv[0], { args: argv.slice(1), cwd: ctx.cwd });
      }

      // 4) Gone.
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

  private async doSyncJshCommands(): Promise<void> {
    try {
      const jshIndex = await this.host.scriptCatalog.getJshIndex(this.scanRoots());
      const jshMap = jshIndex.commands;
      for (const collision of jshIndex.collisions) {
        log.warn(
          `jsh command '${collision.name}' is provided by more than one skill; using ${collision.winnerPath} (${collision.reason}), shadowed ${collision.shadowedPaths.join(', ')}`
        );
      }
      const wfMap = await this.getFilteredWorkflowCommands();
      const wasmMap = await this.host.scriptCatalog.getWasmCommands();

      // .jsh names: keep the existing path-keyed registry + guard.
      for (const [name, scriptPath] of jshMap) {
        if (!this.host.isCommandAllowed(name)) continue;
        if (this.host.builtinCommandNames.has(name) && !this.registeredJshCommands.has(name)) {
          continue;
        }
        if (this.registeredJshCommands.get(name) === scriptPath) continue;
        this.host.bash.registerCommand(
          this.host.wrapCommandForDispatch(this.makeScriptCommand(name))
        );
        this.registeredJshCommands.set(name, scriptPath);
        this.host.builtinCommandNames.add(name);
      }

      // Wasm programs (filtered like workflows) and workflows share the unified handler.
      const wasmNames = [...wasmMap.keys()].filter((name) => this.host.isCommandAllowed(name));
      this.registerLateScriptNames(wasmNames, this.registeredWasmCommands);
      this.registerLateScriptNames(wfMap.keys(), this.registeredWorkflowCommands);
    } finally {
      this.jshSyncInflight = null;
      if (this.jshSyncDirty) {
        this.jshSyncDirty = false;
        void this.syncJshCommands().catch(() => undefined);
      }
    }
  }

  /**
   * Register the SAME unified handler ONCE per name for a script source below `.jsh`
   * (wasm programs, workflows). It resolves precedence at dispatch, so a name that
   * another source already registered is only recorded, and a real built-in is never
   * overridden.
   */
  private registerLateScriptNames(names: Iterable<string>, registered: Set<string>): void {
    const scriptSources = [
      this.registeredJshCommands,
      this.registeredWasmCommands,
      this.registeredWorkflowCommands,
    ];
    for (const name of names) {
      if (registered.has(name)) continue; // already handled
      if (scriptSources.some((source) => source !== registered && source.has(name))) {
        registered.add(name);
        continue;
      }
      if (this.host.builtinCommandNames.has(name)) continue; // never override a real built-in
      this.host.bash.registerCommand(
        this.host.wrapCommandForDispatch(this.makeScriptCommand(name))
      );
      registered.add(name);
      this.host.builtinCommandNames.add(name);
    }
  }
}
