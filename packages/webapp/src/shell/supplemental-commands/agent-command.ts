import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import { normalizePath } from '../../fs/path-utils.js';
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from '../../scoops/types.js';

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
  /** Forwarded to the bridge as the spawned scoop's thinking-level override. */
  thinkingLevel?: ThinkingLevel;
  /** Structured output schema for the spawned scoop. */
  structuredOutputSchema?: Record<string, unknown>;
}

/** Options accepted by {@link createAgentCommand}. */
export interface AgentCommandOptions {
  /**
   * Returns the JID of the scoop (or cone) that owns the shell invoking
   * `agent`. Forwarded to the bridge as `parentJid` so the spawned scoop
   * inherits the parent's `config.modelId` (or falls back to the global UI
   * selection when the parent has none). Returns `undefined` when the shell
   * is not attached to a scoop context — e.g., the terminal panel's own
   * standalone `AlmostBashShell`.
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
  --thinking <level>      Reasoning / thinking level for the spawned scoop.
                          One of: off, minimal, low, medium, high, xhigh.
                          Defaults to inheriting the parent's level (or 'off'
                          when there is no parent). 'xhigh' is silently
                          clamped to 'high' when the resolved model doesn't
                          support it. Ignored entirely for non-reasoning
                          models. Aliased as --effort.
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
  agent --thinking high . "*" "design a careful plan first"
  agent --read-only /workspace/,/shared/assets/ . "*" "review the docs"
`;

interface ParsedArgs {
  help: boolean;
  cwd?: string;
  allowedCommandsRaw?: string;
  prompt?: string;
  modelId?: string;
  visiblePaths?: string[];
  thinkingLevel?: ThinkingLevel;
  structuredOutputSchema?: Record<string, unknown>;
  error?: string;
}

/** Parse a flag with value. Returns error or { value, consumed } on success. */
function parseFlagWithValue(
  flag: string,
  args: string[],
  i: number
): { error: string } | { value: string; consumed: number } {
  const next = args[i + 1];
  if (next === undefined) {
    return { error: `agent: ${flag} requires a value` };
  }
  if (next.length > 0 && next.startsWith('-')) {
    return { error: `agent: ${flag} requires a value` };
  }
  if (next === '') {
    return { error: `agent: ${flag} requires a non-empty value` };
  }
  return { value: next, consumed: 2 };
}

/** Parse --thinking or --effort flag. */
function parseThinkingFlag(
  flag: string,
  args: string[],
  i: number
): { error?: string; value?: ThinkingLevel; consumed: number } {
  const result = parseFlagWithValue(flag, args, i);
  if ('error' in result) return { error: result.error, consumed: 0 };

  if (!isThinkingLevel(result.value)) {
    return {
      error: `agent: ${flag} must be one of: ${THINKING_LEVELS.join(', ')}`,
      consumed: 0,
    };
  }
  return { value: result.value, consumed: result.consumed };
}

/** Parse --read-only flag. */
function parseReadOnlyFlag(
  args: string[],
  i: number
): { error?: string; value?: string[]; consumed: number } {
  const result = parseFlagWithValue('--read-only', args, i);
  if ('error' in result) return { error: result.error, consumed: 0 };

  const parsed = parseReadOnlyPaths(result.value);
  if (parsed.length === 0) {
    return { error: 'agent: --read-only requires a non-empty value', consumed: 0 };
  }
  return { value: parsed, consumed: result.consumed };
}

/** Parse --schema-b64 flag. */
function parseSchemaFlag(
  args: string[],
  i: number
): { error?: string; value?: Record<string, unknown>; consumed: number } {
  const next = args[i + 1];
  if (next === undefined || next === '' || (next.length > 0 && next.startsWith('-'))) {
    return { error: 'agent: --schema-b64 requires a value', consumed: 0 };
  }
  try {
    const bin = atob(next);
    const decoded = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
    );
    if (typeof decoded !== 'object' || decoded === null) {
      return { error: 'agent: --schema-b64 must decode to a JSON object', consumed: 0 };
    }
    return { value: decoded as Record<string, unknown>, consumed: 2 };
  } catch {
    return { error: 'agent: --schema-b64 must be valid base64-encoded JSON', consumed: 0 };
  }
}

/** State accumulated during arg parsing. */
interface ParseState {
  positionals: string[];
  help: boolean;
  modelId?: string;
  visiblePaths?: string[];
  thinkingLevel?: ThinkingLevel;
  schemaOut?: Record<string, unknown>;
}

/** Process one argument. Returns error or null and consumed count. */
function processArg(
  arg: string,
  args: string[],
  i: number,
  state: ParseState
): { error?: string; consumed: number } {
  if (state.positionals.length === 2) {
    state.positionals.push(arg);
    return { consumed: 1 };
  }

  if (arg === '-h' || arg === '--help') {
    state.help = true;
    return { consumed: 1 };
  }

  if (arg === '--model') {
    const result = parseFlagWithValue(arg, args, i);
    if ('error' in result) return { error: result.error, consumed: 0 };
    state.modelId = result.value;
    return { consumed: result.consumed };
  }

  if (arg === '--thinking' || arg === '--effort') {
    const result = parseThinkingFlag(arg, args, i);
    if (result.error) return { error: result.error, consumed: 0 };
    state.thinkingLevel = result.value;
    return { consumed: result.consumed };
  }

  if (arg === '--read-only') {
    const result = parseReadOnlyFlag(args, i);
    if (result.error) return { error: result.error, consumed: 0 };
    state.visiblePaths = result.value;
    return { consumed: result.consumed };
  }

  if (arg === '--schema-b64') {
    const result = parseSchemaFlag(args, i);
    if (result.error) return { error: result.error, consumed: 0 };
    state.schemaOut = result.value;
    return { consumed: result.consumed };
  }

  if (arg.length > 0 && arg.startsWith('-')) {
    return { error: `agent: unknown flag '${arg}'`, consumed: 0 };
  }

  state.positionals.push(arg);
  return { consumed: 1 };
}

/** Validate positional args. Returns error or parsed result. */
function validatePositionals(
  state: ParseState
):
  | { help: true }
  | { error: string }
  | { cwd: string; allowedCommandsRaw: string; prompt: string } {
  if (state.help) {
    return { help: true };
  }

  if (state.positionals.length < 3) {
    const missing = ['<cwd>', '<allowed-commands>', '<prompt>'][state.positionals.length];
    return { error: `agent: missing required argument ${missing}` };
  }

  if (state.positionals.length > 3) {
    return { error: 'agent: too many arguments' };
  }

  const [cwd, allowedCommandsRaw, prompt] = state.positionals;
  return { cwd, allowedCommandsRaw, prompt };
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
  const state: ParseState = {
    positionals: [],
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const result = processArg(args[i], args, i, state);
    if (result.error) return { help: false, error: result.error };
    i += result.consumed;
  }

  const validation = validatePositionals(state);
  if ('help' in validation) {
    return { help: true };
  }
  if ('error' in validation) {
    return { help: false, error: validation.error };
  }

  const positionals = validation as {
    cwd: string;
    allowedCommandsRaw: string;
    prompt: string;
  };

  return {
    help: false,
    cwd: positionals.cwd,
    allowedCommandsRaw: positionals.allowedCommandsRaw,
    prompt: positionals.prompt,
    modelId: state.modelId,
    visiblePaths: state.visiblePaths,
    thinkingLevel: state.thinkingLevel,
    structuredOutputSchema: state.schemaOut,
  };
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

/** Validate cwd exists and is a directory. Returns error message or null. */
/**
 * Map a cwd `stat` outcome to an error message (or null if valid). Kept sync so
 * the command body can `await ctx.fs.stat` INLINE — wrapping the await in an
 * async helper adds a microtask hop before `spawn`, which the bridge-ordering
 * test (`blocks until the bridge promise resolves`) is calibrated against.
 */
function cwdValidationError(
  stat: { isDirectory: boolean } | null,
  missing: boolean,
  cwdArg: string
): string | null {
  if (missing) return `agent: cwd not found: ${cwdArg}\n`;
  if (stat && !stat.isDirectory) return `agent: cwd not a directory: ${cwdArg}\n`;
  return null;
}

/** Check cwd is writable (sandbox escape guard). Returns error message or null. */
function checkCwdWritable(fs: unknown, resolvedCwd: string, cwdArg: string): string | null {
  const fsWithCanWrite = fs as { canWrite?: (p: string) => boolean };
  if (typeof fsWithCanWrite.canWrite === 'function' && !fsWithCanWrite.canWrite(resolvedCwd)) {
    return `agent: cwd not writable: ${cwdArg}\n`;
  }
  return null;
}

/** Build spawn options from parsed args and context. */
function buildSpawnOptions(
  parsed: ParsedArgs,
  resolvedCwd: string,
  allowedCommands: string[],
  prompt: string,
  ctx: { cwd: string },
  getParentJid?: () => string | undefined
): AgentSpawnOptions {
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
  if (parsed.thinkingLevel !== undefined) {
    spawnOptions.thinkingLevel = parsed.thinkingLevel;
  }
  if (parsed.structuredOutputSchema !== undefined) {
    spawnOptions.structuredOutputSchema = parsed.structuredOutputSchema;
  }
  if (ctx.cwd && ctx.cwd.length > 0) {
    spawnOptions.invokingCwd = ctx.cwd;
  }
  const parentJid = getParentJid?.();
  if (parentJid !== undefined && parentJid.length > 0) {
    spawnOptions.parentJid = parentJid;
  }
  return spawnOptions;
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
      return { stdout: '', stderr: 'agent: <cwd> must not be empty\n', exitCode: 1 };
    }

    const resolvedCwd = resolveCwd(cwdArg, ctx.cwd);
    const allowedCommands = parseAllowedCommands(parsed.allowedCommandsRaw ?? '');
    const prompt = parsed.prompt ?? '';

    let cwdStat: { isDirectory: boolean } | null = null;
    let cwdMissing = false;
    try {
      cwdStat = await ctx.fs.stat(resolvedCwd);
    } catch {
      cwdMissing = true;
    }
    const cwdError = cwdValidationError(cwdStat, cwdMissing, cwdArg);
    if (cwdError) {
      return { stdout: '', stderr: cwdError, exitCode: 1 };
    }

    const writableError = checkCwdWritable(ctx.fs, resolvedCwd, cwdArg);
    if (writableError) {
      return { stdout: '', stderr: writableError, exitCode: 1 };
    }

    const bridge = getBridge();
    if (!bridge) {
      return { stdout: '', stderr: 'agent: orchestrator bridge not available\n', exitCode: 1 };
    }

    const spawnOptions = buildSpawnOptions(
      parsed,
      resolvedCwd,
      allowedCommands,
      prompt,
      ctx,
      getParentJid
    );

    // `runSpawn` calls `bridge.spawn` synchronously before its first await, so
    // spawn-start is still reached promptly (no extra microtask before spawn).
    return runSpawn(bridge, spawnOptions);
  });
}

/** Await the bridge spawn and map its result/throw to a command result. */
async function runSpawn(
  bridge: AgentBridge,
  spawnOptions: AgentSpawnOptions
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await bridge.spawn(spawnOptions);
    const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : 0;
    const finalText = result?.finalText;
    if (exitCode === 0) {
      return { stdout: formatForStdout(finalText), stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: formatForStderr(finalText), exitCode };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('agent bridge threw', err);
    return { stdout: '', stderr: `${message}\n`, exitCode: 1 };
  }
}
