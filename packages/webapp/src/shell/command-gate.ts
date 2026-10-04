import type { Command, ExecResult, ResolvedCommandContext } from 'just-bash';
import { SUDOERS_D_DIR, type SudoersPolicy, sanitizeGrantPattern } from '../base/sudoers.js';
import type { VirtualFS } from '../fs/index.js';
import { FsError } from '../fs/types.js';
import type { SudoBroker } from '../sudo/types.js';
import {
  commandSudoSubject,
  enforceCommandSudo,
  SUDO_REFUSED_EXIT_CODE,
} from './sudo/command-guard.js';
import { SUDO_REASON_ENV } from './sudo/command-reason.js';
import { PLUMBING } from './supplemental-commands/git-credential-command.js';

export interface ShellSudoConfig {
  getPolicy: () => SudoersPolicy | null;

  broker: SudoBroker;

  persistCommandGrant?: (pattern: string) => Promise<void>;

  transparentGating?: boolean;

  defaultDisposition?: import('../base/sudoers.js').DefaultDisposition;
}

export interface CommandGateOptions {
  getSudo: () => ShellSudoConfig | undefined;
  fs: VirtualFS;
}

export class CommandGate {
  private pendingCommandGrants: string[] = [];

  private pendingSudoBypasses = new Map<string, number>();

  constructor(private readonly options: CommandGateOptions) {}

  isTransparentGatingEnabled(): boolean {
    const sudo = this.options.getSudo();
    return !!sudo && sudo.transparentGating !== false;
  }

  wrapCommandForSudo(command: Command): Command {
    if (!this.isTransparentGatingEnabled() || PLUMBING.has(command.name)) return command;
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

  async gateCommandDispatch(
    name: string,
    args: string[],
    reason?: string
  ): Promise<ExecResult | null> {
    const sudo = this.options.getSudo();
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
        this.queueGrant(pattern);
      },
      defaultDisposition: sudo.defaultDisposition,
      ...(reason ? { reason } : {}),
    });
    if (result.allowed) return null;

    return {
      stdout: '',
      stderr: `${result.message}\n`,
      exitCode: result.exitCode ?? SUDO_REFUSED_EXIT_CODE,
    };
  }

  queueGrant(pattern: string): void {
    this.pendingCommandGrants.push(pattern);
  }

  registerSudoBypass(subject: string): void {
    const key = subject.trim();
    if (!key) return;
    this.pendingSudoBypasses.set(key, (this.pendingSudoBypasses.get(key) ?? 0) + 1);
  }

  consumeSudoBypass(subject: string): boolean {
    const count = this.pendingSudoBypasses.get(subject);
    if (!count) return false;
    if (count === 1) {
      this.pendingSudoBypasses.delete(subject);
    } else {
      this.pendingSudoBypasses.set(subject, count - 1);
    }
    return true;
  }

  async flushPendingCommandGrants(): Promise<void> {
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
    const sink = this.options.getSudo()?.persistCommandGrant;
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
}
