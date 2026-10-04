/**
 * Dispatch-time sudo / grant gate for the cone's shell.
 *
 * Owns the transparent `Cmnd` wrapper, the one-shot bypass the explicit
 * `sudo` command registers after the human already approved, and the
 * post-exec flush of "Always" grants (those writes cannot run inside
 * just-bash's timer-blocked execution box).
 */

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

export interface CommandGateOptions {
  getSudo: () => ShellSudoConfig | undefined;
  fs: VirtualFS;
}

export class CommandGate {
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

  constructor(private readonly options: CommandGateOptions) {}

  /**
   * True when the dispatch-time transparent `Cmnd` gate should wrap every
   * command. Requires a sudo config AND `transparentGating !== false` —
   * defaults to enabled (agent-shell behavior) when the flag is omitted.
   */
  isTransparentGatingEnabled(): boolean {
    const sudo = this.options.getSudo();
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
  wrapCommandForSudo(command: Command): Command {
    // Plumbing runs inside a call of its command, which the gate already saw.
    if (!this.isTransparentGatingEnabled() || PLUMBING.has(command.name)) return command;
    const guard = (args: string[], reason?: string) =>
      this.gateCommandDispatch(command.name, args, reason);
    return {
      ...command,
      async execute(args: string[], ctx: ResolvedCommandContext): Promise<ExecResult> {
        // Read the reason from THIS command's own env, the same way
        // realm-backed commands recover their run pid — a shell shared by
        // concurrent runs must not hand one run's explanation to another.
        const denial = await guard(args, ctx.env?.get(SUDO_REASON_ENV));
        if (denial) return denial;
        return command.execute(args, ctx);
      },
    };
  }

  /**
   * Run the command-level sudo guard for a single dispatch. Returns a denial
   * `ExecResult` (exit 77, no execution) when approval was refused; `null` when
   * the command may run. No-op when sudo is unconfigured or the active policy
   * is null.
   *
   * `reason` is the run's leading-comment explanation, read from the
   * dispatching command's own environment — see `sudo/command-reason.ts`.
   */
  async gateCommandDispatch(
    name: string,
    args: string[],
    reason?: string
  ): Promise<ExecResult | null> {
    const sudo = this.options.getSudo();
    if (!sudo) return null;

    const subject = commandSudoSubject(name, args);

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

  /** Queue a confirmed "Always" grant for the post-exec flush. */
  queueGrant(pattern: string): void {
    this.pendingCommandGrants.push(pattern);
  }

  /**
   * Register a one-shot bypass for the next transparent `Cmnd` gate dispatch
   * matching `subject`. Invoked by the explicit `sudo` command after it has
   * already collected human approval, so the inner command does not prompt
   * twice. Multiple registrations for the same subject stack (multiset).
   */
  registerSudoBypass(subject: string): void {
    const key = subject.trim();
    if (!key) return;
    this.pendingSudoBypasses.set(key, (this.pendingSudoBypasses.get(key) ?? 0) + 1);
  }

  /**
   * Consume a pending bypass for `subject`. Returns `true` when a bypass was
   * pending (and was decremented), `false` otherwise.
   */
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

  /**
   * Drain queued grants, persisting each confirmed "Always" grant. Called
   * after `bash.exec()` returns, so the writes happen outside just-bash's
   * timer-blocked execution box. Failures are swallowed per-grant so a
   * persistence error never fails the command the user already approved.
   */
  async flushPendingCommandGrants(): Promise<void> {
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
