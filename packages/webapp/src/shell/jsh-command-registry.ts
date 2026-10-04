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
  readonly registeredJshCommands = new Map<string, string>();

  readonly registeredWorkflowCommands = new Set<string>();

  readonly registeredWasmCommands = new Set<string>();

  private jshSyncInflight: Promise<void> | null = null;

  private jshSyncDirty = false;

  constructor(private readonly host: JshCommandRegistryHost) {}

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

  async getJshCommandNames(): Promise<string[]> {
    return [...(await this.getFilteredJshCommands()).keys()];
  }

  async getWorkflowCommandNames(): Promise<string[]> {
    return [...(await this.getFilteredWorkflowCommands()).keys()];
  }

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

  makeScriptCommand(name: string): Command {
    const host = this.host;
    const catalog = host.scriptCatalog;
    const discoveryFs = host.discoveryFs;
    const cmdName = name;
    const executeInner = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
      const execFn: typeof ctx.exec =
        ctx.exec ??
        ((cmd, opts) =>
          host.bash.exec(cmd, {
            env: opts?.env ?? Object.fromEntries(ctx.env),
            cwd: opts?.cwd ?? ctx.cwd,
            args: opts?.args,
            ...(opts?.env !== undefined ? { replaceEnv: true } : {}),
          }));

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

      const wasm = (await catalog.getWasmCommands()).get(cmdName);
      if (wasm) {
        const { runWasmCommand } = await import('./supplemental-commands/wasm/run.js');
        return runWasmCommand(
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

  private registerLateScriptNames(names: Iterable<string>, registered: Set<string>): void {
    const scriptSources = [
      this.registeredJshCommands,
      this.registeredWasmCommands,
      this.registeredWorkflowCommands,
    ];
    for (const name of names) {
      if (registered.has(name)) continue;
      if (scriptSources.some((source) => source !== registered && source.has(name))) {
        registered.add(name);
        continue;
      }
      if (this.host.builtinCommandNames.has(name)) continue;
      this.host.bash.registerCommand(
        this.host.wrapCommandForDispatch(this.makeScriptCommand(name))
      );
      registered.add(name);
      this.host.builtinCommandNames.add(name);
    }
  }
}
