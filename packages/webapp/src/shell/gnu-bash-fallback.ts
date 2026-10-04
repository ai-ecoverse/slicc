import type { Bash, BashExecResult, ByteString, CommandContext } from 'just-bash';
import { carriedEnv, runOnGnuBash, SHELL_CHOICE_ENV } from './gnu-bash.js';
import type { JshProcessConfig } from './jsh-executor.js';
import { OUTPUT_TEE_ENV, RUN_PID_ENV } from './run-env.js';
import type { ScriptCatalog } from './script-catalog.js';
import { extractLeadingCommentReason, SUDO_REASON_ENV } from './sudo/command-reason.js';
import type { NativeGate } from './supplemental-commands/wasm/launch.js';

export interface GnuBashFallbackHost {
  gnuBash: boolean;
  lastEnv: Record<string, string>;
  cwd: string;
  umask: number;
  vfsAdapter: CommandContext['fs'];
  bash: Bash;
  scriptCatalog: ScriptCatalog;
  outputTees: Map<string, (chunk: string) => void>;
  gateNativeCommand: NativeGate;
  buildJshProcessConfig: (runPid?: number) => JshProcessConfig | undefined;
  gitIdentity: () => Promise<{ name: string; email: string }>;
  flushPendingCommandGrants: () => Promise<void>;
  applyPendingEnvWrites: () => void;
  syncJshCommands: () => Promise<void>;
  adoptCwd: (cwd: string) => void;
  adoptEnv: (env: Record<string, string>) => void;
}

export class GnuBashFallback {
  constructor(private readonly host: GnuBashFallbackHost) {}

  async usesGnuBash(): Promise<boolean> {
    const host = this.host;
    if (!host.gnuBash || host.lastEnv[SHELL_CHOICE_ENV] === 'just-bash') return false;
    if (typeof SharedArrayBuffer !== 'function') return false;
    return (await host.scriptCatalog.getWasmCommands()).has('bash');
  }

  async runOnGnuBash(
    command: string,
    signal: AbortSignal | undefined,
    runPid: number | undefined,
    stdin: ByteString,
    outputTeeId: string | undefined,
    capturePipeStatus: boolean
  ): Promise<BashExecResult & { pipeStatus?: number[] }> {
    const host = this.host;
    const { runWasmCommand, withoutRealmDefaults } = await import(
      './supplemental-commands/wasm/run.js'
    );
    const sudoReason = extractLeadingCommentReason(command);
    const env: Record<string, string> = {
      ...host.lastEnv,
      ...(runPid === undefined ? {} : { [RUN_PID_ENV]: String(runPid) }),
      ...(sudoReason ? { [SUDO_REASON_ENV]: sudoReason } : {}),
    };
    const tee = outputTeeId === undefined ? undefined : host.outputTees.get(outputTeeId);
    const run = await runOnGnuBash(command, {
      env,
      run: (args, runEnv, fds) =>
        runWasmCommand(args, this.wasmContext(runEnv, signal, stdin), {
          processConfig: host.buildJshProcessConfig(runPid),
          gate: host.gateNativeCommand,
          onOutput: tee,
          fds,
          commands: () => host.scriptCatalog.getWasmCommands(),
          gitIdentity: () => host.gitIdentity(),
        }),
    });
    const pathBefore = host.lastEnv.PATH;
    if (run.state) {
      host.adoptCwd(run.state.cwd);

      host.adoptEnv(
        carriedEnv(withoutRealmDefaults(run.state.env, env), [
          RUN_PID_ENV,
          SUDO_REASON_ENV,
          OUTPUT_TEE_ENV,
        ])
      );
    }

    if (host.lastEnv.PATH !== pathBefore) await host.syncJshCommands().catch(() => undefined);
    await host.flushPendingCommandGrants();
    host.applyPendingEnvWrites();
    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      env: { ...host.lastEnv },
      ...(capturePipeStatus && run.state ? { pipeStatus: run.state.pipeStatus } : {}),
    };
  }

  private wasmContext(
    env: Record<string, string>,
    signal: AbortSignal | undefined,
    stdin: ByteString
  ): CommandContext {
    const host = this.host;
    return {
      fs: host.vfsAdapter,
      cwd: host.cwd,
      env: new Map(Object.entries(env)),
      exportedEnv: env,
      stdin,
      signal,

      exec: (cmd: string, opts: Parameters<Bash['exec']>[1]) =>
        host.bash.exec(cmd, { ...opts, umask: host.umask }),
    } as unknown as CommandContext;
  }
}
