import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import { normalizePath } from '../../fs/path-utils.js';

const log = createLogger('agent-command');

/** Options forwarded to the orchestrator bridge. */
interface AgentSpawnOptions {
  cwd: string;
  allowedCommands: string[];
  prompt: string;
  modelId?: string;
  parentJid?: string;
  visiblePaths?: string[];
  /**
   * The invoking shell's cwd at the moment `agent` ran. The bridge
   * unions this into visiblePaths (read-only) when `--read-only` is
   * absent, so the spawned scoop can READ the directory it was launched
   * from without gaining write access there.
   *
   * See the `agent` command's help text and {@link AgentSpawnOptions}
   * on the bridge for the read-only tradeoff.
   */
  invokingCwd?: string;
}

/** Options accepted by {@link createAgentCommand}. */
export interface AgentCommandOptions {
  /**
   * Returns the JID of the scoop (or cone) that owns the shell invoking
   * `agent`. Forwarded to the bridge as `parentJid` so the spawned scoop
   * inherits the parent's `config.modelId` (or falls back to the global UI
   * selection when the parent has none). Returns `undefined` when the shell
   * is not attached to a scoop context — e.g., the terminal panel's own
   * standalone `WasmShell`.
   */
  getParentJid?: () => string | undefined;
}

/** Result returned by the orchestrator bridge. */
interface AgentSpawnResult {
  finalText?: string | null;
  exitCode: number;
}

/** The minimal contract exposed by the orchestrator bridge. */
interface AgentBridge {
  spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult>;
}

const AGENT_HELP = `usage: agent <cwd> <allowed-commands> <prompt>

Spawns a sub-scoop, feeds it a task, blocks until the agent loop completes,
then prints the scoop's final message on stdout.

Arguments:
  <cwd>               Working directory for the spawned scoop. Becomes the
                      scoop's sole writable prefix. Relative paths are resolved
                      against the current shell's cwd; '.', '..', and absolute
                      paths are all supported.
  <allowed-commands>  Comma-separated list of bash commands the scoop may run.
                      Use '*' to allow every command. Whitespace is trimmed
                      around each entry; duplicates are tolerated.
  <prompt>            Prompt forwarded verbatim to the scoop.

Default sandbox:
  The spawned scoop sees (read-only):  /workspace/ + the invoking shell's cwd
  The spawned scoop writes to:         <cwd>, /shared/, /scoops/<name>/, /tmp/
  /tmp/ is always writable — no flag toggles it.

Options:
  --model <id>            Override the model id used by the spawned scoop.
                          Defaults to inheriting the parent's model.
  --read-only <paths>     Comma-separated VFS paths exposed read-only to the
                          spawned scoop (visiblePaths). Pure replace — when
                          set, the default ["/workspace/"] AND the implicit
                          ctx.cwd read-only add are BOTH dropped. Pass an
                          explicit list if you want them back (e.g.
                          "/workspace/,$(pwd)"). Each entry is normalized to
                          a trailing slash.
  -h, --help              Show this help message and exit.

Examples:
  agent . "*" "say hello in one word"
  agent /home ls,wc,find "how many files do I have in my home directory"
  agent --model claude-haiku-4-5 . "*" "summarize files in this directory"
  agent --read-only /workspace/,/shared/assets/ . "*" "review the docs"
`;

interface ParsedArgs {
  help: boolean;
  cwd?: string;
  allowedCommandsRaw?: string;
  prompt?: string;
  modelId?: string;
  visiblePaths?: string[];
  error?: string;
}

/**
 * Parse the command line following these rules:
 *   - `-h` / `--help` are always flags EXCEPT when exactly two positional args
 *     have been collected and we are consuming the third (prompt) slot. This
 *     allows `agent . "*" "-h"` to forward `-h` as the prompt.
 *   - `--model <id>` consumes the next token as the model id. A missing,
 *     flag-looking, or empty value is an error.
 *   - Any other `-...` / `--...` token is an unknown-flag error.
 *   - Exactly three positional arguments are required; more is a too-many
 *     error.
 */
function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  let help = false;
  let modelId: string | undefined;
  let visiblePaths: string[] | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // When the next positional slot is the prompt, accept the arg verbatim —
    // flag parsing does NOT apply at this position. This preserves prompts
    // like "-h" or "--model".
    if (positionals.length === 2) {
      positionals.push(arg);
      i += 1;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      help = true;
      i += 1;
      continue;
    }

    if (arg === '--model') {
      const next = args[i + 1];
      if (next === undefined) {
        return { help: false, error: 'agent: --model requires a value' };
      }
      // A flag-looking value is rejected (e.g., `--model --help`).
      if (next.length > 0 && next.startsWith('-')) {
        return { help: false, error: 'agent: --model requires a value' };
      }
      if (next === '') {
        return { help: false, error: 'agent: --model requires a non-empty value' };
      }
      modelId = next;
      i += 2;
      continue;
    }

    if (arg === '--read-only') {
      const next = args[i + 1];
      if (next === undefined) {
        return { help: false, error: 'agent: --read-only requires a value' };
      }
      // A flag-looking value is rejected (e.g., `--read-only --help`).
      if (next.length > 0 && next.startsWith('-')) {
        return { help: false, error: 'agent: --read-only requires a value' };
      }
      if (next === '') {
        return { help: false, error: 'agent: --read-only requires a non-empty value' };
      }
      const parsed = parseReadOnlyPaths(next);
      if (parsed.length === 0) {
        return { help: false, error: 'agent: --read-only requires a non-empty value' };
      }
      visiblePaths = parsed;
      i += 2;
      continue;
    }

    // Any other leading-dash token in a non-prompt slot is an unknown flag.
    if (arg.length > 0 && arg.startsWith('-')) {
      return { help: false, error: `agent: unknown flag '${arg}'` };
    }

    positionals.push(arg);
    i += 1;
  }

  if (help) {
    return { help: true };
  }

  if (positionals.length < 3) {
    const missing = ['<cwd>', '<allowed-commands>', '<prompt>'][positionals.length];
    return { help: false, error: `agent: missing required argument ${missing}` };
  }

  if (positionals.length > 3) {
    return { help: false, error: 'agent: too many arguments' };
  }

  const [cwd, allowedCommandsRaw, prompt] = positionals;
  return { help: false, cwd, allowedCommandsRaw, prompt, modelId, visiblePaths };
}

/**
 * Parse a `--read-only` value into an array of VFS path prefixes. Entries are
 * comma-separated, trimmed of surrounding whitespace, and empty entries are
 * dropped. Paths are forwarded verbatim otherwise — the bridge normalizes them
 * to trailing-slash prefixes before handing them to `RestrictedFS`.
 */
function parseReadOnlyPaths(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveCwd(cwdArg: string, ctxCwd: string): string {
  if (cwdArg.startsWith('/')) {
    return normalizePath(cwdArg);
  }
  const base = ctxCwd.length > 0 ? ctxCwd : '/';
  return normalizePath(`${base}/${cwdArg}`);
}

function parseAllowedCommands(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Normalize `finalText` for stdout: preserve internal content verbatim (including
 * leading/trailing whitespace that is NOT a newline) and ensure exactly one
 * trailing newline. `null` / `undefined` collapse to just `'\n'`.
 */
function formatForStdout(finalText: string | null | undefined): string {
  if (finalText == null) return '\n';
  return finalText.replace(/\n+$/, '') + '\n';
}

/** Stderr variant of {@link formatForStdout}. Empty/null input produces empty stderr. */
function formatForStderr(finalText: string | null | undefined): string {
  if (finalText == null || finalText === '') return '';
  return finalText.replace(/\n+$/, '') + '\n';
}

function getBridge(): AgentBridge | undefined {
  const hook = (globalThis as Record<string, unknown>).__slicc_agent as AgentBridge | undefined;
  if (!hook || typeof hook.spawn !== 'function') {
    return undefined;
  }
  return hook;
}

/**
 * Create the `agent` supplemental command.
 *
 * Usage: `agent <cwd> <allowed-commands> <prompt>` plus `--model <id>` /
 * `--read-only <paths>` / `-h` / `--help`. The command forwards parsed
 * options to the orchestrator bridge published at
 * `globalThis.__slicc_agent` and prints the bridge's `finalText` on
 * stdout with exactly one trailing newline. On a bridge error
 * (exit code `!== 0` or promise rejection) the error text is written to
 * stderr and the exit code is propagated.
 *
 * Sandbox defaults:
 *   - writablePaths: `<cwd>`, `/shared/`, the scoop's scratch folder,
 *     AND `/tmp/` (always-on ambient scratch; not toggleable).
 *   - visiblePaths: `/workspace/` + the invoking shell's `ctx.cwd`
 *     (so the agent can READ where it was launched from), de-duped.
 *
 * The `--read-only` flag is pure-replace for visiblePaths — passing it
 * drops BOTH the `/workspace/` default AND the implicit `ctx.cwd` add.
 * Callers who want the invoking cwd back alongside a custom list must
 * include it explicitly, e.g. `--read-only "/docs/,$(pwd)"`.
 */
export function createAgentCommand(options: AgentCommandOptions = {}): Command {
  const { getParentJid } = options;
  return defineCommand('agent', async (args, ctx) => {
    const parsed = parseArgs(args);

    if (parsed.help) {
      return { stdout: AGENT_HELP, stderr: '', exitCode: 0 };
    }

    if (parsed.error) {
      return { stdout: '', stderr: `${parsed.error}\n`, exitCode: 1 };
    }

    const cwdArg = parsed.cwd ?? '';
    if (cwdArg === '') {
      return {
        stdout: '',
        stderr: 'agent: <cwd> must not be empty\n',
        exitCode: 1,
      };
    }

    const resolvedCwd = resolveCwd(cwdArg, ctx.cwd);
    const allowedCommands = parseAllowedCommands(parsed.allowedCommandsRaw ?? '');
    const prompt = parsed.prompt ?? '';

    // Validate the resolved cwd exists and is a directory BEFORE invoking the
    // orchestrator bridge. This keeps bad paths from spawning a scoop that
    // would immediately fail with a less actionable error.
    try {
      const stat = await ctx.fs.stat(resolvedCwd);
      if (!stat.isDirectory) {
        return {
          stdout: '',
          stderr: `agent: cwd not a directory: ${cwdArg}\n`,
          exitCode: 1,
        };
      }
    } catch {
      return {
        stdout: '',
        stderr: `agent: cwd not found: ${cwdArg}\n`,
        exitCode: 1,
      };
    }

    // Sandbox-escape guard: when the invoking shell is a scoop, `ctx.fs` is a
    // RestrictedFS whose `stat` intentionally succeeds on sandbox *parents*
    // (so the shell can probe PATH and traverse toward allowed prefixes).
    // Without this check a scoop could pass `/scoops` as `<cwd>` and the
    // orchestrator bridge would happily grant it a writable prefix covering
    // every sibling scoop. Require `cwd` to be writable by the caller before
    // forwarding to the bridge. Terminal shells wrap an unrestricted
    // VirtualFS (via `VfsAdapter.canWrite`, which returns `true`), so this
    // predicate is a no-op for top-level invocations.
    const fsWithCanWrite = ctx.fs as unknown as { canWrite?: (p: string) => boolean };
    if (typeof fsWithCanWrite.canWrite === 'function' && !fsWithCanWrite.canWrite(resolvedCwd)) {
      return {
        stdout: '',
        stderr: `agent: cwd not writable: ${cwdArg}\n`,
        exitCode: 1,
      };
    }

    const bridge = getBridge();
    if (!bridge) {
      return {
        stdout: '',
        stderr: 'agent: orchestrator bridge not available\n',
        exitCode: 1,
      };
    }

    const spawnOptions: AgentSpawnOptions = {
      cwd: resolvedCwd,
      allowedCommands,
      prompt,
    };
    if (parsed.modelId !== undefined) {
      spawnOptions.modelId = parsed.modelId;
    }
    if (parsed.visiblePaths !== undefined) {
      spawnOptions.visiblePaths = parsed.visiblePaths;
    }
    // Forward the invoking shell's cwd. The bridge uses it as an
    // implicit read-only root (visiblePaths) ONLY when `--read-only`
    // was NOT passed — that flag is pure-replace, so we don't sneak an
    // extra entry into a list the user explicitly opted out of. A
    // caller who still wants the ctx.cwd visible alongside `--read-only`
    // can pass `--read-only foo/,$(pwd)` to re-add it.
    if (ctx.cwd && ctx.cwd.length > 0) {
      spawnOptions.invokingCwd = ctx.cwd;
    }
    // Forward the parent scoop's JID when available so the bridge can
    // inherit the parent's model id (see `AgentSpawnOptions.parentJid` in
    // `agent-bridge.ts`). The hook is omitted for top-level terminal
    // invocations where no scoop owns the shell.
    const parentJid = getParentJid?.();
    if (parentJid !== undefined && parentJid.length > 0) {
      spawnOptions.parentJid = parentJid;
    }

    try {
      const result = await bridge.spawn(spawnOptions);
      const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : 0;
      const finalText = result?.finalText;

      if (exitCode === 0) {
        return { stdout: formatForStdout(finalText), stderr: '', exitCode: 0 };
      }

      return {
        stdout: '',
        stderr: formatForStderr(finalText),
        exitCode,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('agent bridge threw', err);
      return {
        stdout: '',
        stderr: `${message}\n`,
        exitCode: 1,
      };
    }
  });
}
