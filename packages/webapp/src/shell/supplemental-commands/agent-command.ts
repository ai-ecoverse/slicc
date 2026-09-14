import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../base/logger.js';
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from '../../base/thinking-level.js';
import { normalizePath } from '../../fs/path-utils.js';
import type { ImplementedWorkspaceMode } from '../../work-unit/workspace-mode.js';
import { parseWorkspaceMode } from '../../work-unit/workspace-mode.js';

const log = createLogger('agent-command');

interface JsonSchemaObject {
  type?: string;
  [keyword: string]: unknown;
}

interface AgentSpawnOptions {
  cwd: string;
  allowedCommands: string[];
  prompt: string;
  modelId?: string;
  parentJid?: string;
  visiblePaths?: string[];

  invokingCwd?: string;

  thinkingLevel?: ThinkingLevel;

  backgroundAfterSeconds?: number;

  structuredOutputSchema?: JsonSchemaObject;

  signal?: AbortSignal;

  persistSession?: boolean;

  workspaceMode?: ImplementedWorkspaceMode;
}

export interface AgentCommandOptions {
  getParentJid?: () => string | undefined;
}

interface AgentSpawnResult {
  finalText?: string | null;
  exitCode: number;
}

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
  The spawned scoop sees (read-only):  the OWNING cone's workspace (+ skills)
                                       + the invoking shell's cwd
  The spawned scoop writes to:         <cwd>, /shared/, /scoops/<name>/, /tmp/
  /tmp/ is always writable — no flag toggles it.

Options:
  --model <id>            Override the model id used by the spawned scoop.
                          Accepts an exact id, a shorthand ('haiku', 'sonnet',
                          'claude-haiku-4-5'), or the 'provider:model' form
                          the 'models' command prints
                          ('openrouter:openai/gpt-5.6-terra-pro'). A bare id
                          resolves against the selected provider first, then
                          against any other CONFIGURED provider that offers
                          it; matching several is an error listing the
                          qualified ids. The scoop runs on the provider the
                          model was resolved from. A model from a provider
                          other than the selected one must also be allowed in
                          /etc/models; the error quotes the line to add. An id
                          that cannot be resolved (or is not allowed) exits 1 —
                          it never falls back to the parent's model. Defaults
                          to inheriting the parent's model.
  --thinking <level>      Reasoning / thinking level for the spawned scoop.
                          One of: off, minimal, low, medium, high, xhigh.
                          Defaults to inheriting the parent's level (or 'off'
                          when there is no parent). 'xhigh' is silently
                          clamped to 'high' when the resolved model doesn't
                          support it. Ignored entirely for non-reasoning
                          models. Aliased as --effort.
  --workspace-mode <mode> Isolation policy for the spawned scoop's filesystem
                          view. One of: private, shared-readonly (default),
                          snapshot, shared-live. Default shared-readonly is
                          today's sandbox: parent workspace + skills + the
                          invoking cwd are visible, <cwd> + /shared/ + scratch
                          are writable, mounts stay readable. private is an
                          isolated sandbox (own cwd/scratch only — no parent
                          workspace, no implicit /shared/, mounts are NOT
                          auto-visible). snapshot and shared-live are not
                          implemented and exit 1. Explicit --read-only still
                          replaces the mode's visiblePaths.
  --read-only <paths>     Comma-separated VFS paths exposed read-only to the
                          spawned scoop (visiblePaths). Pure replace — the
                          owning cone's roots AND the implicit ctx.cwd add are
                          BOTH dropped. To keep them, name your own cone's
                          workspace ("$(pwd),/workspace/skills/") — a literal
                          /workspace/ is the PRIMARY cone's. Each entry is
                          normalized to a trailing slash.
  --background-after <s>  Seconds the spawned scoop's bash tool waits for a
                          command before detaching it to the background and
                          continuing (default 600). The detached command's exit
                          code and output come back to the scoop as a
                          "Background Command" lick, so a slow or stuck command
                          never wedges an unsupervised run. Use 0 to detach
                          every command immediately. Must be >= 0.
  --persist-session       Write the spawned agent's full session transcript to
                          /sessions/agent-<name>-<timestamp>.md (durable —
                          survives a new chat) for later human analysis.
  --no-persist-session    Do not write a session transcript at all. With
                          NEITHER flag, the transcript is written to
                          /tmp/agent-<name>-<timestamp>.md, which a new chat
                          clears.
  -h, --help              Show this help message and exit.

Examples:
  agent . "*" "say hello in one word"
  agent /home ls,wc,find "how many files do I have in my home directory"
  agent --model claude-haiku-4-5 . "*" "summarize files in this directory"
  agent --thinking high . "*" "design a careful plan first"
  agent --read-only /workspace/,/shared/assets/ . "*" "review the docs"
  agent --workspace-mode private . "*" "work only in this directory"
  agent --background-after 60 . "*" "run the slow build and report"
`;

interface ParsedArgs {
  help: boolean;
  cwd?: string;
  allowedCommandsRaw?: string;
  prompt?: string;
  modelId?: string;
  visiblePaths?: string[];
  thinkingLevel?: ThinkingLevel;
  backgroundAfterSeconds?: number;
  structuredOutputSchema?: JsonSchemaObject;
  persistSession?: boolean;
  workspaceMode?: ImplementedWorkspaceMode;
  error?: string;
}

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

function parseBackgroundAfterFlag(
  args: string[],
  i: number
): { error?: string; value?: number; consumed: number } {
  const result = parseFlagWithValue('--background-after', args, i);
  if ('error' in result) return { error: result.error, consumed: 0 };
  const seconds = Number(result.value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return {
      error: 'agent: --background-after must be a number of seconds >= 0',
      consumed: 0,
    };
  }
  return { value: seconds, consumed: result.consumed };
}

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

function parseSchemaFlag(
  args: string[],
  i: number
): { error?: string; value?: JsonSchemaObject; consumed: number } {
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
    return { value: decoded as JsonSchemaObject, consumed: 2 };
  } catch {
    return { error: 'agent: --schema-b64 must be valid base64-encoded JSON', consumed: 0 };
  }
}

interface ParseState {
  positionals: string[];
  help: boolean;
  modelId?: string;
  visiblePaths?: string[];
  thinkingLevel?: ThinkingLevel;
  backgroundAfterSeconds?: number;
  schemaOut?: JsonSchemaObject;
  persistSession?: boolean;
  workspaceMode?: ImplementedWorkspaceMode;
}

type FlagHandler = (
  flag: string,
  args: string[],
  i: number,
  state: ParseState
) => { error?: string; consumed: number };

const FLAG_HANDLERS: Record<string, FlagHandler> = {
  '-h': (_flag, _args, _i, state) => {
    state.help = true;
    return { consumed: 1 };
  },
  '--help': (_flag, _args, _i, state) => {
    state.help = true;
    return { consumed: 1 };
  },
  '--model': (flag, args, i, state) => {
    const result = parseFlagWithValue(flag, args, i);
    if ('error' in result) return { error: result.error, consumed: 0 };
    state.modelId = result.value;
    return { consumed: result.consumed };
  },
  '--thinking': (flag, args, i, state) => {
    const result = parseThinkingFlag(flag, args, i);
    if (result.error) return { error: result.error, consumed: 0 };
    state.thinkingLevel = result.value;
    return { consumed: result.consumed };
  },
  '--effort': (flag, args, i, state) => {
    const result = parseThinkingFlag(flag, args, i);
    if (result.error) return { error: result.error, consumed: 0 };
    state.thinkingLevel = result.value;
    return { consumed: result.consumed };
  },
  '--background-after': (_flag, args, i, state) => {
    const result = parseBackgroundAfterFlag(args, i);
    if (result.error) return { error: result.error, consumed: 0 };
    state.backgroundAfterSeconds = result.value;
    return { consumed: result.consumed };
  },
  '--workspace-mode': (flag, args, i, state) => {
    const result = parseFlagWithValue(flag, args, i);
    if ('error' in result) return { error: result.error, consumed: 0 };
    const parsed = parseWorkspaceMode(result.value);
    if (!parsed.ok) return { error: `agent: ${parsed.error}`, consumed: 0 };
    state.workspaceMode = parsed.mode;
    return { consumed: result.consumed };
  },
  '--read-only': (_flag, args, i, state) => {
    const result = parseReadOnlyFlag(args, i);
    if (result.error) return { error: result.error, consumed: 0 };
    state.visiblePaths = result.value;
    return { consumed: result.consumed };
  },
  '--schema-b64': (_flag, args, i, state) => {
    const result = parseSchemaFlag(args, i);
    if (result.error) return { error: result.error, consumed: 0 };
    state.schemaOut = result.value;
    return { consumed: result.consumed };
  },
  '--persist-session': (_flag, _args, _i, state) => {
    state.persistSession = true;
    return { consumed: 1 };
  },
  '--no-persist-session': (_flag, _args, _i, state) => {
    state.persistSession = false;
    return { consumed: 1 };
  },
};

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

  if (arg.length > 0 && arg.startsWith('-')) {
    const handler = FLAG_HANDLERS[arg];
    if (!handler) return { error: `agent: unknown flag '${arg}'`, consumed: 0 };
    return handler(arg, args, i, state);
  }

  state.positionals.push(arg);
  return { consumed: 1 };
}

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
    backgroundAfterSeconds: state.backgroundAfterSeconds,
    structuredOutputSchema: state.schemaOut,
    persistSession: state.persistSession,
    workspaceMode: state.workspaceMode,
  };
}

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

function formatForStdout(finalText: string | null | undefined): string {
  if (finalText == null) return '\n';
  return finalText.replace(/\n+$/, '') + '\n';
}

function formatForStderr(finalText: string | null | undefined): string {
  if (finalText == null || finalText === '') return '';
  return finalText.replace(/\n+$/, '') + '\n';
}

type SliccAgentGlobal = typeof globalThis & { __slicc_agent?: AgentBridge };

function getBridge(): AgentBridge | undefined {
  const hook = (globalThis as SliccAgentGlobal).__slicc_agent;
  if (!hook || typeof hook.spawn !== 'function') {
    return undefined;
  }
  return hook;
}

function cwdValidationError(
  stat: { isDirectory: boolean } | null,
  missing: boolean,
  cwdArg: string
): string | null {
  if (missing) return `agent: cwd not found: ${cwdArg}\n`;
  if (stat && !stat.isDirectory) return `agent: cwd not a directory: ${cwdArg}\n`;
  return null;
}

function checkCwdWritable(fs: unknown, resolvedCwd: string, cwdArg: string): string | null {
  const fsWithCanWrite = fs as { canWrite?: (p: string) => boolean };
  if (typeof fsWithCanWrite.canWrite === 'function' && !fsWithCanWrite.canWrite(resolvedCwd)) {
    return `agent: cwd not writable: ${cwdArg}\n`;
  }
  return null;
}

function buildSpawnOptions(
  parsed: ParsedArgs,
  resolvedCwd: string,
  allowedCommands: string[],
  prompt: string,
  ctx: { cwd: string; signal?: AbortSignal },
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
  if (parsed.backgroundAfterSeconds !== undefined) {
    spawnOptions.backgroundAfterSeconds = parsed.backgroundAfterSeconds;
  }
  if (parsed.structuredOutputSchema !== undefined) {
    spawnOptions.structuredOutputSchema = parsed.structuredOutputSchema;
  }
  if (parsed.persistSession !== undefined) {
    spawnOptions.persistSession = parsed.persistSession;
  }
  if (parsed.workspaceMode !== undefined) {
    spawnOptions.workspaceMode = parsed.workspaceMode;
  }
  if (ctx.cwd && ctx.cwd.length > 0) {
    spawnOptions.invokingCwd = ctx.cwd;
  }

  if (ctx.signal !== undefined) {
    spawnOptions.signal = ctx.signal;
  }
  const parentJid = getParentJid?.();
  if (parentJid !== undefined && parentJid.length > 0) {
    spawnOptions.parentJid = parentJid;
  }
  return spawnOptions;
}

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

    return runSpawn(bridge, spawnOptions);
  });
}

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
