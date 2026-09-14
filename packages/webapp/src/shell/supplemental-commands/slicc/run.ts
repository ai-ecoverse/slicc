import { uint8ToBase64 } from '@slicc/shared-ts';
import type { CommandContext } from 'just-bash';
import { getPanelRpcClient } from '../../../kernel/panel-rpc.js';
import { stdinAsLatin1, stdinAsText } from '../../just-bash-compat.js';

const SLICC_MAX_MS = 24 * 60 * 60 * 1000;

const DEFAULT_WATCH_SECONDS = 30;

type ExecResult = { stdout: string; stderr: string; exitCode: number };

const VERBS = ['prompt', 'exec', 'watch'] as const;
type Verb = (typeof VERBS)[number];

function err(message: string): ExecResult {
  return { stdout: '', stderr: message.endsWith('\n') ? message : `${message}\n`, exitCode: 1 };
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function sliccHelp(): ExecResult {
  return ok(`slicc - talk to another SLICC leader as a client

Usage: slicc <target> prompt [--steer] [--timeout <s>] <text...>
       slicc <target> exec [--cwd <dir>] [--timeout <s>] <command...>
       slicc <target> watch [--for <s>] [--until-idle] [<scoop-jid>]
       slicc list
       slicc detach <name> | --all

<target> is a join URL (https://.../join/<token>) or the name of an existing
attachment from \`slicc list\`. A join URL is dialed once and kept warm, so
repeated commands against the same leader reuse one connection.

This is the reverse of \`ssh\`: \`ssh\` runs a command on a follower of THIS
tray, \`slicc <url> exec\` runs one in a REMOTE leader's shell. It is also not
\`host join\` — this instance keeps leading its own tray while attached.

Verbs:
  prompt   Send one chat turn; streams the remote agent's reply to stdout
  exec     Run a command in the remote leader's virtual shell
  watch    Passively tail the remote agent's output (read-only; sends nothing)

Options:
  --name <name>        Name the attachment (default: slicc-<n>)
  --once               Detach as soon as the verb finishes
  --timeout <seconds>  Give up on the verb after this long
  --steer              prompt: interrupt the remote's running turn (don't queue)
  --cwd <dir>          exec: working directory on the remote leader
  --for <seconds>      watch: how long to tail (default ${DEFAULT_WATCH_SECONDS})
  --until-idle         watch: stop early once a turn finishes
  --help, -h           Show this help

Text arguments are curl-style: literal, @path to read a VFS file, or - / @- to
read piped stdin.

Examples:
  slicc https://tray.example/join/abc123 exec "uname -a"
  slicc https://tray.example/join/abc123 prompt "what are you working on?"
  git log -5 | slicc lab prompt @-
  slicc lab watch --for 60 --until-idle
  slicc list
`);
}

function verbHelp(verb: Verb): ExecResult {
  switch (verb) {
    case 'prompt':
      return ok(`slicc <target> prompt - send one chat turn to a remote SLICC leader

Usage: slicc <target> prompt [--steer] [--timeout <seconds>] <text...>

Streams the remote agent's next assistant turn to stdout and exits when the turn
completes. <text> is curl-style: literal words, @path (a VFS file), or - / @-
(piped stdin).

Options:
  --steer              Interrupt the remote's running turn instead of queueing
  --timeout <seconds>  Abort the turn (and tell the remote to stop) after this long
`);
    case 'exec':
      return ok(`slicc <target> exec - run a command in a remote leader's virtual shell

Usage: slicc <target> exec [--cwd <dir>] [--timeout <seconds>] <command...>

Runs <command> in the REMOTE leader's shell — its VFS, its tools — and returns
that command's stdout, stderr, and exit code. Piped stdin is forwarded.
The mirror of \`ssh\`, which runs a command on a follower of this tray instead.

Options:
  --cwd <dir>          Working directory on the remote leader
  --timeout <seconds>  Interrupt the command (SIGINT) after this long
`);
    case 'watch':
      return ok(`slicc <target> watch - tail a remote SLICC agent's live output

Usage: slicc <target> watch [--for <seconds>] [--until-idle] [<scoop-jid>]

Read-only: sends nothing to the remote leader. Bounded, because a shell command
returns one buffered result — there is no incremental stdout to hold a tail
open against, so the window is a flag rather than a Ctrl+C.

With no <scoop-jid>, every scoop's events are rendered. The cone's jid is a
generated uid (not "cone") — read it from the remote's \`host\` output.

Options:
  --for <seconds>      How long to tail (default ${DEFAULT_WATCH_SECONDS})
  --until-idle         Stop early once a turn completes and the agent goes idle
`);
  }
}

interface ParsedVerb {
  target: string;
  verb: Verb;
  rest: string[];
  name?: string;
  once: boolean;
  timeoutSec?: number;
  cwd?: string;
  forSec?: number;
  untilIdle: boolean;
  steer: boolean;
}

type ParseOutcome =
  | { kind: 'verb'; parsed: ParsedVerb }
  | { kind: 'list' }
  | { kind: 'detach'; name?: string; all: boolean }
  | { kind: 'help' }
  | { kind: 'verb-help'; verb: Verb }
  | { kind: 'error'; message: string };

function numericFlag(name: string, raw: string | undefined): number | { error: string } {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value <= 0) {
    return { error: `slicc: ${name} requires a positive number of seconds` };
  }
  return value;
}

interface FlagBag {
  name?: string;
  once: boolean;
  timeoutSec?: number;
  cwd?: string;
  forSec?: number;
  untilIdle: boolean;
  steer: boolean;
}

function consumeFlag(
  arg: string,
  next: string | undefined,
  bag: FlagBag
): number | null | { error: string } {
  switch (arg) {
    case '--once':
      bag.once = true;
      return 1;
    case '--until-idle':
      bag.untilIdle = true;
      return 1;
    case '--steer':
      bag.steer = true;
      return 1;
    case '--name':
    case '--cwd': {
      if (next === undefined) return { error: `slicc: ${arg} requires a value` };
      if (arg === '--name') bag.name = next;
      else bag.cwd = next;
      return 2;
    }
    case '--timeout':
    case '--for': {
      const parsed = numericFlag(arg, next);
      if (typeof parsed !== 'number') return parsed;
      if (arg === '--timeout') bag.timeoutSec = parsed;
      else bag.forSec = parsed;
      return 2;
    }
    default:
      if (arg.startsWith('-') && arg !== '-') return { error: `slicc: unknown flag: ${arg}` };
      return null;
  }
}

function verbAt(positional: string[], arg: string): Verb | { error: string } | null {
  if (positional.length !== 1) return null;
  if (positional[0] === 'detach' || positional[0] === 'list') return null;
  if (!(VERBS as readonly string[]).includes(arg)) return { error: unknownVerbMessage(arg) };
  return arg as Verb;
}

interface ScanResult {
  positional: string[];
  verb?: Verb;
  bag: FlagBag;

  restIndex: number;
}

function scanArgs(args: string[]): ScanResult | ParseOutcome {
  const positional: string[] = [];
  const bag: FlagBag = { once: false, untilIdle: false, steer: false };
  let verb: Verb | undefined;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (verb && !arg.startsWith('-')) break;

    if (arg === '--help' || arg === '-h') {
      return verb ? { kind: 'verb-help', verb } : { kind: 'help' };
    }
    if (arg === '--all' && positional[0] === 'detach') return { kind: 'detach', all: true };

    const consumed = consumeFlag(arg, args[i + 1], bag);
    if (consumed !== null) {
      if (typeof consumed !== 'number') return { kind: 'error', message: consumed.error };
      i += consumed;
      continue;
    }

    const classified = verbAt(positional, arg);
    if (classified !== null) {
      if (typeof classified !== 'string') return { kind: 'error', message: classified.error };
      verb = classified;
    }
    positional.push(arg);
    i += 1;
  }

  return { positional, verb, bag, restIndex: i };
}

function parseSliccArgs(args: string[]): ParseOutcome {
  if (args.length === 0) return { kind: 'help' };

  const scanned = scanArgs(args);
  if ('kind' in scanned) return scanned;
  const { positional, verb, bag, restIndex } = scanned;
  const [first, second] = positional;

  if (first === 'list') {
    return positional.length > 1
      ? { kind: 'error', message: `slicc list: unexpected argument: ${second}` }
      : { kind: 'list' };
  }
  if (first === 'detach') {
    return second === undefined
      ? { kind: 'error', message: 'slicc detach: missing attachment name (or --all)' }
      : { kind: 'detach', name: second, all: false };
  }
  if (second === undefined || !verb) {
    return { kind: 'error', message: unknownVerbMessage(second) };
  }

  return {
    kind: 'verb',
    parsed: {
      target: first,
      verb,
      rest: [...positional.slice(2), ...args.slice(restIndex)],
      ...bag,
    },
  };
}

function unknownVerbMessage(verb: string | undefined): string {
  const head = verb ? `slicc: unknown verb: ${verb}` : 'slicc: missing verb';
  const hint =
    verb === 'follow'
      ? '\n`follow` is CLI-only: it serves a remote leader commands on the local machine. ' +
        'This command is a client only.'
      : '';
  return `${head}\nExpected one of ${VERBS.join(', ')}. \`slicc --help\` for usage.${hint}`;
}

function readStdinText(ctx: CommandContext): string | undefined {
  if (ctx.stdin === undefined) return undefined;
  const text = stdinAsText(ctx.stdin);
  return text.length > 0 ? text : undefined;
}

function encodeStdin(ctx: CommandContext): string | undefined {
  if (ctx.stdin === undefined) return undefined;
  const latin1 = stdinAsLatin1(ctx.stdin);
  if (latin1.length === 0) return undefined;
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i) & 0xff;
  return uint8ToBase64(bytes);
}

async function resolveTextArg(
  rest: string[],
  ctx: CommandContext
): Promise<string | { error: string }> {
  if (rest.length !== 1) return rest.join(' ');
  const only = rest[0];
  if (only === '-' || only === '@-') {
    const piped = readStdinText(ctx);
    if (piped === undefined) return { error: 'slicc: no piped stdin to read' };
    return piped;
  }
  if (only.startsWith('@')) {
    const path = only.slice(1);
    try {
      return await ctx.fs.readFile(path, 'utf-8');
    } catch (error) {
      return { error: `slicc: cannot read ${path}: ${errorText(error)}` };
    }
  }
  return only;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAttachments(
  attachments: Array<{ name: string; joinUrl: string; state: string; trayId: string | null }>
): string {
  if (attachments.length === 0) {
    return 'No attachments.\nAttach one with: slicc <join-url> exec "uname -a"\n';
  }
  const lines = ['attachments:'];
  for (const attachment of attachments) {
    lines.push(`  - ${attachment.name} (${attachment.state})`);
    lines.push(`      ${attachment.joinUrl}`);
    if (attachment.trayId) lines.push(`      tray: ${attachment.trayId}`);
  }
  return `${lines.join('\n')}\n`;
}

function isJoinUrlTarget(target: string): boolean {
  return target.startsWith('http://') || target.startsWith('https://');
}

type Rpc = NonNullable<ReturnType<typeof getPanelRpcClient>>;

async function runList(rpc: Rpc): Promise<ExecResult> {
  const { attachments } = await rpc.call('slicc-list', undefined);
  return ok(formatAttachments(attachments));
}

async function runDetach(rpc: Rpc, outcome: { name?: string; all: boolean }): Promise<ExecResult> {
  if (outcome.all) {
    const { attachments } = await rpc.call('slicc-list', undefined);
    for (const attachment of attachments) {
      await rpc.call('slicc-detach', { name: attachment.name });
    }
    return ok(`Detached ${attachments.length} attachment(s).\n`);
  }
  const name = outcome.name as string;
  const { detached } = await rpc.call('slicc-detach', { name });
  return detached ? ok(`Detached ${name}.\n`) : err(`slicc detach: no such attachment: ${name}`);
}

async function resolveTarget(rpc: Rpc, parsed: ParsedVerb): Promise<string | { error: string }> {
  if (!isJoinUrlTarget(parsed.target)) return parsed.target;
  try {
    const info = await rpc.call(
      'slicc-attach',
      { joinUrl: parsed.target, name: parsed.name },
      { timeoutMs: 60_000 }
    );
    return info.name;
  } catch (error) {
    return { error: `slicc: ${errorText(error)}` };
  }
}

async function runVerbOp(
  rpc: Rpc,
  parsed: ParsedVerb,
  ctx: CommandContext,
  name: string,
  runToken: string
): Promise<ExecResult> {
  const timeoutMs = parsed.timeoutSec ? parsed.timeoutSec * 1000 : undefined;

  const bridgeTimeoutMs = (timeoutMs ?? SLICC_MAX_MS) + 5000;

  if (parsed.verb === 'watch') {
    const durationMs = (parsed.forSec ?? DEFAULT_WATCH_SECONDS) * 1000;
    return toExecResult(
      await rpc.call(
        'slicc-watch',
        {
          name,
          runToken,
          durationMs,
          scoopJid: parsed.rest[0],
          untilIdle: parsed.untilIdle,
        },
        { timeoutMs: durationMs + 10_000 }
      )
    );
  }

  const text = await resolveTextArg(parsed.rest, ctx);
  if (typeof text !== 'string') return err(text.error);

  if (parsed.verb === 'prompt') {
    return toExecResult(
      await rpc.call(
        'slicc-prompt',
        { name, text, runToken, steer: parsed.steer, timeoutMs },
        { timeoutMs: bridgeTimeoutMs }
      )
    );
  }

  return toExecResult(
    await rpc.call(
      'slicc-exec',
      {
        name,
        command: text,
        runToken,
        cwd: parsed.cwd,
        timeoutMs,

        stdin:
          parsed.rest.length === 1 && isStdinArg(parsed.rest[0]) ? undefined : encodeStdin(ctx),
      },
      { timeoutMs: bridgeTimeoutMs }
    )
  );
}

function missingArgError(verb: Verb): ExecResult {
  const noun = verb === 'prompt' ? 'text' : 'command';
  return err(`slicc ${verb}: missing ${noun}\nUsage: slicc <target> ${verb} <${noun}...>`);
}

export async function runSlicc(args: string[], ctx: CommandContext): Promise<ExecResult> {
  const outcome = parseSliccArgs(args);
  if (outcome.kind === 'help') return sliccHelp();
  if (outcome.kind === 'verb-help') return verbHelp(outcome.verb);
  if (outcome.kind === 'error') return err(outcome.message);

  const rpc = getPanelRpcClient();
  if (!rpc) {
    return err('slicc: not available in this environment (needs the standalone app)');
  }
  if (outcome.kind === 'list') return await runList(rpc);
  if (outcome.kind === 'detach') return await runDetach(rpc, outcome);

  const { parsed } = outcome;
  if (parsed.verb !== 'watch' && parsed.rest.length === 0) return missingArgError(parsed.verb);

  const name = await resolveTarget(rpc, parsed);
  if (typeof name !== 'string') return err(name.error);

  const runToken = `slicc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const onAbort = (): void => {
    void rpc.call('slicc-cancel', { runToken }).catch(() => {});
  };
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await runVerbOp(rpc, parsed, ctx, name, runToken);
  } catch (error) {
    return err(`slicc: ${errorText(error)}`);
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort);
    if (parsed.once) {
      await rpc.call('slicc-detach', { name }).catch(() => {});
    }
  }
}

function isStdinArg(arg: string): boolean {
  return arg === '-' || arg === '@-';
}

function toExecResult(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}): ExecResult {
  if (result.error) {
    return {
      stdout: result.stdout,
      stderr: `${result.stderr}slicc: ${result.error}\n`,
      exitCode: result.exitCode || 1,
    };
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}
