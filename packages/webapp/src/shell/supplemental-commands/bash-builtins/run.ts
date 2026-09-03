/**
 * Bash builtins that `help` advertises but just-bash does not implement.
 *
 * Imported on FIRST USE by `bash-builtins-command.ts`, never at
 * registration: `supplemental-commands/index.ts` sits in the kernel
 * worker's boot-critical graph and the usage text below is far too much
 * to carry there (`packages/webapp/first-load-budget.json`).
 *
 * just-bash ships bash's full `help` topic table while implementing only
 * part of it, so `help` listed thirteen names — `bg`, `caller`, `disown`,
 * `enable`, `fc`, `fg`, `jobs`, `logout`, `suspend`, `times`, `trap`,
 * `ulimit`, `umask` — that every invocation answered with
 * `command not found` (127). `trap` was the dangerous one: the parser
 * accepted `trap 'cleanup' EXIT` and the script kept running, so a
 * cleanup handler that was never installed looked like it worked
 * (issue #2816).
 *
 * Custom commands are consulted after builtins, so registering these
 * names reaches dispatch precisely because just-bash has no builtin for
 * them — the table below can never shadow a builtin that upstream later
 * implements.
 *
 * Two behaviours, no third:
 *
 *   - **Faithful.** Where real bash without job control already answers
 *     with a diagnostic, this shell answers with bash's own text and exit
 *     code (`bash: fg: no job control`, exit 1). `jobs` prints an empty
 *     job table because `&` runs synchronously here, so by the time
 *     `jobs` runs the "background" command has already finished — for
 *     long-lived kernel processes use `ps`. `trap` honours every form
 *     that asks for nothing (`-l`, `-p`, reset, ignore).
 *   - **Loud.** Anything this shell genuinely cannot do exits 2 with a
 *     one-line reason and, where one exists, a pointer to the working
 *     alternative. Never a silent no-op.
 *
 * `select` is a missing shell *keyword*, not a builtin — it fails in
 * just-bash's parser before command lookup happens, so no registration
 * here can reach it. It is not in the `help` table either, so nothing
 * advertises it; see `docs/shell-reference.md`.
 */

import type { Command, ResolvedCommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { isHelpRequest } from '../subcommand-help.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

const ok = (stdout = ''): CmdResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode: number): CmdResult => ({
  stdout: '',
  stderr: stderr.endsWith('\n') ? stderr : `${stderr}\n`,
  exitCode,
});

/** bash's own diagnostic prefix, so error text matches the real shell. */
const bashError = (name: string, message: string, exitCode = 1): CmdResult =>
  fail(`bash: ${name}: ${message}`, exitCode);

/**
 * Refusal for a builtin this shell cannot honour. Exit 2 (bash's
 * builtin-misuse code) rather than 0, so `set -e` scripts stop instead of
 * carrying on as if the builtin had worked.
 */
const unsupported = (name: string, reason: string, hint?: string): CmdResult =>
  fail(`bash: ${name}: ${reason}${hint ? `\nbash: ${name}: ${hint}` : ''}`, 2);

/**
 * Signals the kernel actually delivers (`kill-command.ts`), numbered as
 * Linux does. `trap -l` lists these rather than bash's full 1..64 table:
 * naming a signal that can never be raised here would be the same lie
 * the `help` table was telling.
 */
const KERNEL_SIGNALS: ReadonlyArray<readonly [number, string]> = [
  [2, 'SIGINT'],
  [9, 'SIGKILL'],
  [15, 'SIGTERM'],
  [18, 'SIGCONT'],
  [19, 'SIGSTOP'],
];

/** `trap -l` output: two columns, tab-separated, like bash. */
function formatSignalList(): string {
  const cells = KERNEL_SIGNALS.map(([num, name]) => `${String(num).padStart(2, ' ')}) ${name}`);
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    lines.push(cells.slice(i, i + 2).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Job control
// ---------------------------------------------------------------------------

const JOBS_HELP = `jobs - display status of jobs

Usage: jobs [jobspec ...]

This shell has no job table: \`&\` runs its command synchronously, so a
backgrounded command has already finished by the time \`jobs\` runs and the
listing is always empty.

For long-lived kernel processes (.jsh realms, detached bash-tool runs, v86)
use \`ps\`, and \`kill\` to signal them.
`;

function createJobsCommand(): Command {
  return defineCommand('jobs', async (args) => {
    if (isHelpRequest(args)) return ok(JOBS_HELP);
    // Flags select columns/state; with an empty table they all print nothing.
    const jobspec = args.find((a) => !a.startsWith('-'));
    if (jobspec) return bashError('jobs', `${jobspec}: no such job`);
    return ok();
  });
}

const FG_BG_HELP = (name: string, verb: string) => `${name} - ${verb}

Usage: ${name} [job_spec${name === 'bg' ? ' ...' : ''}]

Job control is not available in this shell — \`&\` runs synchronously, so
there is never a stopped or background job to move. \`${name}\` reports
\`no job control\` exactly as bash does in a shell started without it.

See \`ps\` and \`kill\` for the kernel process table.
`;

function createFgCommand(): Command {
  return defineCommand('fg', async (args) => {
    if (isHelpRequest(args)) return ok(FG_BG_HELP('fg', 'move job to the foreground'));
    return bashError('fg', 'no job control');
  });
}

function createBgCommand(): Command {
  return defineCommand('bg', async (args) => {
    if (isHelpRequest(args)) return ok(FG_BG_HELP('bg', 'move jobs to the background'));
    return bashError('bg', 'no job control');
  });
}

const DISOWN_HELP = `disown - remove jobs from the current shell

Usage: disown [-h] [-ar] [jobspec ...]

This shell has no job table (see \`jobs --help\`), so there is never a job to
disown and \`disown\` reports \`no such job\` exactly as bash does.
`;

function createDisownCommand(): Command {
  return defineCommand('disown', async (args) => {
    if (isHelpRequest(args)) return ok(DISOWN_HELP);
    const jobspec = args.find((a) => !a.startsWith('-'));
    // Bare `disown` targets the current job, which never exists here.
    return bashError('disown', `${jobspec ?? 'current'}: no such job`);
  });
}

const SUSPEND_HELP = `suspend - suspend shell execution

Usage: suspend [-f]

Suspending requires job control and a controlling terminal, neither of which
exists in this shell. \`suspend\` reports \`cannot suspend: no job control\`
exactly as bash does.
`;

function createSuspendCommand(): Command {
  return defineCommand('suspend', async (args) => {
    if (isHelpRequest(args)) return ok(SUSPEND_HELP);
    return bashError('suspend', 'cannot suspend: no job control');
  });
}

const LOGOUT_HELP = `logout - exit a login shell

Usage: logout [n]

This shell is not a login shell, so \`logout\` reports
\`not login shell: use \\\`exit'\` exactly as bash does. Use \`exit\` instead.
`;

function createLogoutCommand(): Command {
  return defineCommand('logout', async (args) => {
    if (isHelpRequest(args)) return ok(LOGOUT_HELP);
    return bashError('logout', "not login shell: use `exit'");
  });
}

// ---------------------------------------------------------------------------
// trap
// ---------------------------------------------------------------------------

const TRAP_HELP = `trap - trap signals and other events

Usage: trap [-lp] [[arg] signal_spec ...]

Supported:
  trap                 print trapped signals (always empty — none can be set)
  trap -p [spec ...]   same
  trap -l              list the signals the kernel can deliver
  trap - SPEC ...      reset SPEC to its default (nothing was trapped)
  trap '' SPEC ...     ignore SPEC (nothing raises it here)

NOT supported:
  trap 'command' SPEC  installing a handler

There is no signal-delivery path into a running script in this shell, so a
handler could never fire. Installing one exits 2 with this message rather
than accepting it silently: a cleanup handler that never runs is worse than
one that is refused.

Instead:
  - run cleanup on the normal path, or in the \`||\` branch of the command
    that can fail
  - \`kill\` signals kernel processes (\`ps\`) directly; see \`kill --help\`
`;

/** The two handler tokens that ask for nothing: `-` resets, `''` ignores. */
function isTrapAction(token: string): boolean {
  return token === '-' || token === '';
}

function createTrapCommand(): Command {
  return defineCommand('trap', async (args) => {
    if (isHelpRequest(args)) return ok(TRAP_HELP);

    if (args.includes('-l')) return ok(formatSignalList());

    // `trap` and `trap -p [spec ...]` both only REPORT — the table is empty.
    if (args.length === 0 || args.includes('-p')) return ok();

    // `trap - SPEC...` resets to default and `trap '' SPEC...` ignores. Both
    // are satisfied by a shell that traps nothing and raises nothing.
    if (isTrapAction(args[0])) return ok();

    return unsupported(
      'trap',
      'signal handlers are not supported in this shell',
      "the handler would never run — see 'trap --help'"
    );
  });
}

// ---------------------------------------------------------------------------
// Builtins with no implementable behaviour
// ---------------------------------------------------------------------------

interface RefusedBuiltin {
  name: string;
  summary: string;
  usage: string;
  reason: string;
  hint?: string;
  /** Extra lines for `--help`, after usage. */
  notes?: string;
}

const REFUSED: readonly RefusedBuiltin[] = [
  {
    name: 'caller',
    summary: 'return the context of the current subroutine call',
    usage: 'caller [expr]',
    reason: 'call-stack introspection is not supported in this shell',
    hint: 'the interpreter does not expose caller frames',
  },
  {
    name: 'enable',
    summary: 'enable and disable shell builtins',
    usage: 'enable [-a] [-dnps] [-f filename] [name ...]',
    reason: 'builtins cannot be enabled, disabled, or loaded in this shell',
    hint: "list what is available with 'help' or 'commands'",
  },
  {
    name: 'fc',
    summary: 'display or execute commands from the history list',
    usage: 'fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]',
    reason: 'history editing is not supported in this shell',
    hint: "use 'history' to list past commands",
  },
  {
    name: 'times',
    summary: 'display process times',
    usage: 'times',
    reason: 'per-process CPU accounting is not available in this shell',
    hint: "use 'time <command>' for wall-clock timing",
  },
  {
    name: 'ulimit',
    summary: 'modify shell resource limits',
    usage: 'ulimit [-SHabcdefiklmnpqrstuvxPT] [limit]',
    reason: 'resource limits are not configurable in this shell',
    hint: "interpreter limits are fixed at boot; 'df' and 'meminfo' report usage",
  },
  {
    name: 'umask',
    summary: 'display or set the file mode mask',
    usage: 'umask [-p] [-S] [mode]',
    reason: 'file-creation masks are not supported by the virtual filesystem',
    hint: "set modes explicitly with 'chmod'",
  },
];

function refusedHelp(spec: RefusedBuiltin): string {
  const lines = [`${spec.name} - ${spec.summary}`, '', `Usage: ${spec.usage}`, ''];
  if (spec.notes) lines.push(spec.notes, '');
  lines.push(`Not supported: ${spec.reason}.`);
  if (spec.hint) lines.push(`Instead: ${spec.hint}.`);
  lines.push('', 'Invoking it exits 2 rather than succeeding as a no-op.');
  return `${lines.join('\n')}\n`;
}

function createRefusedCommand(spec: RefusedBuiltin): Command {
  return defineCommand(spec.name, async (args) => {
    if (isHelpRequest(args)) return ok(refusedHelp(spec));
    return unsupported(spec.name, spec.reason, spec.hint);
  });
}

// ---------------------------------------------------------------------------

/**
 * Dispatch table, built once per module load (the module itself is loaded
 * once, on the first invocation of any of these names).
 */
const COMMANDS: ReadonlyMap<string, Command> = new Map(
  [
    createJobsCommand(),
    createFgCommand(),
    createBgCommand(),
    createDisownCommand(),
    createSuspendCommand(),
    createLogoutCommand(),
    createTrapCommand(),
    ...REFUSED.map(createRefusedCommand),
  ].map((command) => [command.name, command])
);

/**
 * Run one of the registered builtins. `name` comes from the stub's own
 * name list, so an unknown one is a wiring bug, not user input.
 */
export async function runBashBuiltin(
  name: string,
  args: readonly string[],
  ctx: ResolvedCommandContext
): Promise<CmdResult> {
  const command = COMMANDS.get(name);
  if (!command) {
    throw new Error(`bash-builtins: no implementation registered for '${name}'`);
  }
  return command.execute([...args], ctx) as Promise<CmdResult>;
}
