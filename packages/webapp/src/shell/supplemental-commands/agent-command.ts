import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../base/logger.js';
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from '../../base/thinking-level.js';
import { normalizePath } from '../../fs/path-utils.js';
import type { ImplementedWorkspaceMode } from '../../work-unit/workspace-mode.js';
import { parseWorkspaceMode } from '../../work-unit/workspace-mode.js';
import type { ImageContent } from './agent-images.js';

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

  images?: ImageContent[];

  escalate?: boolean;
}

const MAX_IMAGES = 8;

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
  if (parsed.noEscalate) {
    spawnOptions.escalate = false;
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
      const { AGENT_HELP } = await import('./agent-help.js');
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
      const { readImages } = await import('./agent-images.js');
      const read = await readImages(
        ctx.fs,
        parsed.imagePaths.map((arg) => ({ arg, path: resolveCwd(arg, ctx.cwd) }))
      );
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
