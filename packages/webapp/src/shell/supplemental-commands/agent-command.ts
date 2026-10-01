import { uint8ToBase64 } from '@slicc/shared-ts';
import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../base/logger.js';
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from '../../base/thinking-level.js';
import { normalizePath } from '../../fs/path-utils.js';
import type { ImplementedWorkspaceMode } from '../../work-unit/workspace-mode.js';
import { parseWorkspaceMode } from '../../work-unit/workspace-mode.js';
import { detectMimeType } from './shared.js';

const log = createLogger('agent-command');

/**
 * A JSON Schema object as decoded from `--schema-b64` and forwarded verbatim to
 * the bridge. Structurally mirrors `JsonSchemaObject` in `tools/types.ts`:
 * `shell/` sits below `tools/` in the layer stack, so the shape is restated here
 * rather than imported (the same reason `AgentSpawnOptions` below is a mirror).
 */
interface JsonSchemaObject {
  type?: string;
  [keyword: string]: unknown;
}

/**
 * A prompt image, restated from pi-ai's `ImageContent` (`core/types.ts`) for
 * the same layering reason as {@link JsonSchemaObject}.
 */
interface ImageContent {
  type: 'image';
  /** Base64 of the file's raw bytes. */
  data: string;
  mimeType: string;
}

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
  /**
   * Seconds the spawned scoop's `bash` tool waits before detaching a command
   * (its `background_after` default). Forwarded verbatim to the bridge.
   */
  backgroundAfterSeconds?: number;
  /** Structured output schema for the spawned scoop. */
  structuredOutputSchema?: JsonSchemaObject;
  /**
   * The invoking command's abort signal. `AgentBridge.spawn` stops the spawned
   * scoop when this aborts, which is what makes a `bash` `timeout` kill (or a
   * cancelled turn) reach a nested `agent` instead of leaving it running.
   */
  signal?: AbortSignal;
  /**
   * Tri-value session-transcript persistence forwarded to the bridge:
   * `true` (`--persist-session`) writes a durable `/sessions/...` archive,
   * `false` (`--no-persist-session`) writes nothing, and `undefined` (neither
   * flag) leaves the bridge's default — an ephemeral `/tmp/...` archive.
   */
  persistSession?: boolean;
  /**
   * Workspace isolation mode (#2277). Default `shared-readonly` preserves
   * today's spawn. `private` isolates. Unimplemented modes are rejected
   * at parse time before the bridge is called.
   */
  workspaceMode?: ImplementedWorkspaceMode;
  /** `--image` files, read and base64-encoded; the bridge validates and resizes them. */
  images?: ImageContent[];
  /** `false` for `--no-escalate`: the scoop's sudo requests are refused, not escalated. */
  escalate?: boolean;
}

/** Most `--image` flags one call accepts. */
const MAX_IMAGES = 8;

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
  --image <path>          Attach an image (PNG, JPEG, GIF or WebP) to the
                          prompt, so the scoop can see it without being
                          allowed a command to open it. Repeatable, up to 8;
                          --image=<path> also works. Relative paths resolve
                          against the current shell's cwd. A missing file, a
                          non-image, or a ninth image exits 1 before anything
                          is spawned. Large images are resized to the model's
                          limits.
  --no-escalate           Hold the scoop to its grant. Normally a command not
                          in <allowed-commands>, or a write outside its
                          writable paths, asks the invoking cone for approval;
                          with this flag it is refused at once and the scoop
                          is told it is not permitted for this call. Nothing
                          reaches the cone or the user, and stored "Always"
                          grants do not apply either.
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
  agent --no-escalate --image shot.png . ls "what does this page show?"
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
  imagePaths?: string[];
  noEscalate?: boolean;
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

/**
 * Parse `--background-after <seconds>`. `0` is a legitimate value (detach every
 * command immediately), so the guard rejects only non-numeric and negative
 * input — silently ignoring a typo would leave the scoop on the ten-minute
 * default, i.e. exactly the stall the caller was trying to bound.
 */
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

/** State accumulated during arg parsing. */
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
  imagePaths: string[];
  noEscalate: boolean;
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
  '--image': (flag, args, i, state) => {
    const result = parseFlagWithValue(flag, args, i);
    if ('error' in result) return { error: result.error, consumed: 0 };
    state.imagePaths.push(result.value);
    return { consumed: result.consumed };
  },
  '--no-escalate': (_flag, _args, _i, state) => {
    state.noEscalate = true;
    return { consumed: 1 };
  },
};

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

  if (arg.startsWith('--image=')) {
    const path = arg.slice('--image='.length);
    if (path === '') return { error: 'agent: --image requires a non-empty value', consumed: 0 };
    state.imagePaths.push(path);
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
    imagePaths: [],
    noEscalate: false,
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
  if (state.imagePaths.length > MAX_IMAGES) {
    return {
      help: false,
      error: `agent: too many images (${state.imagePaths.length}); --image accepts at most ${MAX_IMAGES}`,
    };
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
    imagePaths: state.imagePaths,
    noEscalate: state.noEscalate,
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

/**
 * The image type from its leading bytes — PNG, JPEG, GIF or WebP, the formats
 * the model APIs take. A file extension is not trusted: a mislabelled file
 * would only fail later, inside the spawned run.
 */
function sniffImageMime(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 8) === 'PNG\r\n\x1a\n') {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Read each `--image` file as raw bytes (never through a UTF-8 string) and
 * base64 it for the prompt. Fails on the first missing or non-image file.
 */
async function readImages(
  fs: CommandContext['fs'],
  paths: readonly string[],
  ctxCwd: string
): Promise<{ images: ImageContent[] } | { error: string }> {
  const images: ImageContent[] = [];
  for (const path of paths) {
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFileBuffer(resolveCwd(path, ctxCwd));
    } catch {
      return { error: `agent: --image: file not found: ${path}\n` };
    }
    const mimeType = sniffImageMime(bytes);
    if (mimeType === null) {
      return {
        error: `agent: --image: unsupported image type (${detectMimeType(path)}): ${path} — use PNG, JPEG, GIF or WebP\n`,
      };
    }
    images.push({ type: 'image', data: uint8ToBase64(bytes), mimeType });
  }
  return { images };
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

/**
 * The global slot `publishAgentBridge` (`scoops/agent-bridge.ts`) writes the
 * bridge to. Declared here too because `shell/` cannot import from `scoops/`.
 */
type SliccAgentGlobal = typeof globalThis & { __slicc_agent?: AgentBridge };

function getBridge(): AgentBridge | undefined {
  const hook = (globalThis as SliccAgentGlobal).__slicc_agent;
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
  if (parsed.noEscalate) {
    spawnOptions.escalate = false;
  }
  if (ctx.cwd && ctx.cwd.length > 0) {
    spawnOptions.invokingCwd = ctx.cwd;
  }
  // Without this the spawned scoop outlives whatever stopped its caller: the
  // bash tool's `timeout` kill, a cancelled turn, or a `drop_scoop` would end
  // the `agent` command while the child kept making (billable) model calls.
  // `AgentBridge.spawn` already stops the scoop when this aborts.
  if (ctx.signal !== undefined) {
    spawnOptions.signal = ctx.signal;
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

    let images: ImageContent[] | undefined;
    if (parsed.imagePaths !== undefined && parsed.imagePaths.length > 0) {
      const read = await readImages(ctx.fs, parsed.imagePaths, ctx.cwd);
      if ('error' in read) return { stdout: '', stderr: read.error, exitCode: 1 };
      images = read.images;
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
    if (images !== undefined) spawnOptions.images = images;

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
