import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { scratchDir } from '../tmpdir-env.js';
import { playwrightHandlers } from './playwright/handlers/index.js';
import { autoSaveSnapshot, logSession } from './playwright/session-log.js';
import {
  AUTO_SNAPSHOT_COMMANDS,
  frameIdUsedAsTabError,
  getSharedState,
  PLAYWRIGHT_FLAG_SPEC,
  parseFlags,
} from './playwright/state.js';
import type { CmdResult, PlaywrightHandlerCtx } from './playwright/types.js';
import { type KnownFlagSpec, parseKnownFlags } from './subcommand-flags.js';

export { asWebFetch } from './playwright/discover.js';
export { getSharedState, PLAYWRIGHT_COMMAND_NAMES } from './playwright/state.js';
export {
  setPlaywrightTeleportBestFollower,
  setPlaywrightTeleportConnectedFollowers,
} from './playwright/teleport.js';
export type {
  BrowseShSkillMatch,
  GetBestFollowerFn,
  GetConnectedFollowersFn,
  PlaywrightDiscoveryResult,
} from './playwright/types.js';

type PlaywrightBrowser = PlaywrightHandlerCtx['browser'];

function playwrightKnownFlagSpec(): KnownFlagSpec {
  const value = (PLAYWRIGHT_FLAG_SPEC.string ?? []).map((n) => `--${n}`);
  const boolNames = new Set(PLAYWRIGHT_FLAG_SPEC.boolean ?? []);
  for (const [key, val] of Object.entries(PLAYWRIGHT_FLAG_SPEC.alias ?? {})) {
    const group = [key, ...(Array.isArray(val) ? val : [val])];
    if (group.some((n) => boolNames.has(n))) {
      for (const n of group) boolNames.add(n);
    }
  }
  return {
    value,
    bool: [...[...boolNames].map((n) => `--${n}`), '--help', '-h', '--no-iframes'],
  };
}

function argsForKnownFlagWalk(subArgs: readonly string[]): string[] {
  return subArgs.map((a) =>
    a === '--no-iframes' || a.startsWith('--no-iframes=')
      ? a.replace('--no-iframes', '--_noiframes')
      : a
  );
}

function knownFlagSpecForWalk(spec: KnownFlagSpec): KnownFlagSpec {
  return {
    ...spec,
    bool: [...(spec.bool ?? []), '--_noiframes'],
    value: [...(spec.value ?? []), '--_noiframes'],
  };
}

const CONTENTION_NOTE_THRESHOLD_MS = 2000;

type LockWaitSnapshot = { totalWaitMs: number; tabWaitMs?: number };

function tabLockStatsSnapshot(
  browser: PlaywrightBrowser,
  targetId: string | null
): LockWaitSnapshot | undefined {
  if (typeof browser.getTabLockStats !== 'function') return undefined;
  const bridge = browser.getTabLockStats();
  if (!targetId) return { totalWaitMs: bridge.totalWaitMs };
  return {
    totalWaitMs: bridge.totalWaitMs,
    tabWaitMs: browser.getTabLockStats(targetId).tabWaitMs,
  };
}

function withContentionNote(
  browser: PlaywrightBrowser,
  before: LockWaitSnapshot | undefined,
  targetId: string | null,
  result: CmdResult
): CmdResult {
  if (!before || typeof browser.getTabLockStats !== 'function') return result;
  const after = browser.getTabLockStats();
  const waitedMs = after.totalWaitMs - before.totalWaitMs;
  if (waitedMs < CONTENTION_NOTE_THRESHOLD_MS) return result;
  const waited = (waitedMs / 1000).toFixed(1);
  const onThisTab =
    targetId && before.tabWaitMs !== undefined
      ? browser.getTabLockStats(targetId).tabWaitMs - before.tabWaitMs
      : 0;
  const where =
    onThisTab >= CONTENTION_NOTE_THRESHOLD_MS
      ? `${(onThisTab / 1000).toFixed(1)}s of it waiting on this tab (--tab=${targetId})`
      : 'all of it waiting on the bridge, not on this tab';
  const note =
    `note: browser bridge contended — lock waits totaled ${waited}s while this command ran, ` +
    `${where} (queue depth ${after.queueDepth}). Commands on the same tab serialize; ` +
    'commands on different tabs run in parallel — stagger callers on THIS tab, or give ' +
    'each caller its own tab.\n';
  return { ...result, stderr: result.stderr + note };
}

async function commandErrorResult(
  browser: PlaywrightBrowser,
  flags: Record<string, string>,
  err: unknown
): Promise<CmdResult> {
  const message = err instanceof Error ? err.message : String(err);
  const frameHint = flags['tab'] ? await frameIdUsedAsTabError(browser, flags['tab'], err) : null;
  return { stdout: '', stderr: `Error: ${frameHint ?? message}\n`, exitCode: 1 };
}

const ABORTED_EXIT_CODE = 130;

function abortedResult(name: string, subcommand: string, err: unknown): CmdResult {
  const detail =
    err === undefined
      ? 'aborted: the caller stopped waiting for it'
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    stdout: '',
    stderr: `${name} ${subcommand}: ${detail}\n`,
    exitCode: ABORTED_EXIT_CODE,
  };
}

async function runSubcommand(
  name: string,
  subcommand: string,
  handlerCtx: PlaywrightHandlerCtx
): Promise<CmdResult> {
  const handler = playwrightHandlers.get(subcommand);
  if (!handler) {
    return {
      stdout: '',
      stderr: `Unknown command: ${subcommand}\nRun "playwright-cli help" for usage.\n`,
      exitCode: 1,
    };
  }
  const { signal } = handlerCtx;
  try {
    const result = await handler(handlerCtx);

    return signal?.aborted ? abortedResult(name, subcommand, undefined) : result;
  } catch (err) {
    return signal?.aborted
      ? abortedResult(name, subcommand, err)
      : await commandErrorResult(handlerCtx.browser, handlerCtx.flags, err);
  }
}

async function parseSubcommandArgs(
  name: string,
  subcommand: string,
  subArgs: string[],
  knownFlagSpec: KnownFlagSpec
): Promise<{ positional: string[]; flags: Record<string, string> } | { answer: CmdResult }> {
  const known = parseKnownFlags(argsForKnownFlagWalk(subArgs), knownFlagSpecForWalk(knownFlagSpec));
  if ('error' in known) {
    return {
      answer: { stdout: '', stderr: `${name} ${subcommand}: ${known.error}\n`, exitCode: 1 },
    };
  }

  let flags: Record<string, string>;
  try {
    ({ flags } = parseFlags(subArgs));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { answer: { stdout: '', stderr: `${name} ${subcommand}: ${msg}\n`, exitCode: 1 } };
  }

  if (flags['help'] === 'true' || flags['h'] === 'true') {
    const { formatSubcommandHelp } = await import('./playwright/help.js');
    return {
      answer: { stdout: formatSubcommandHelp(name, subcommand), stderr: '', exitCode: 0 },
    };
  }

  let argError: string | null = null;
  try {
    const { validateSubcommandArgs } = await import('./playwright/validate-args.js');
    argError = validateSubcommandArgs(name, subcommand, subArgs, known.positionals);
  } catch {
    argError = null;
  }
  if (argError) return { answer: { stdout: '', stderr: argError, exitCode: 1 } };

  return { positional: known.positionals, flags };
}

export function createPlaywrightCommand(
  name: string,
  browser: PlaywrightBrowser | null | undefined,
  fs: VirtualFS
): Command {
  const state = browser ? getSharedState(browser, fs) : null;
  const knownFlagSpec = playwrightKnownFlagSpec();

  return defineCommand(name, async (args, ctx): Promise<CmdResult> => {
    if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
      const { formatHelp } = await import('./playwright/help.js');
      return { stdout: formatHelp(name) + '\n', stderr: '', exitCode: 0 };
    }

    const subcommand = args[0];
    const subArgs = args.slice(1);

    const parsed = await parseSubcommandArgs(name, subcommand, subArgs, knownFlagSpec);
    if ('answer' in parsed) return parsed.answer;
    const { positional, flags } = parsed;

    if (!browser || !state) {
      return {
        stdout: '',
        stderr: `${name}: browser APIs are unavailable in this environment\n`,
        exitCode: 1,
      };
    }

    const contendedTargetId = flags['tab'] ?? null;
    const lockStatsBefore = tabLockStatsSnapshot(browser, contendedTargetId);

    const result = await runSubcommand(name, subcommand, {
      browser,
      fs,
      state,
      positional,
      flags,
      scratchDir: scratchDir(ctx.env),

      onTab: (targetId, fn) => browser.withTab(targetId, fn, { signal: ctx.signal }),
      signal: ctx.signal,
    });

    const targetId = flags['tab'] ?? null;
    let snapshotPath: string | null = null;

    if (AUTO_SNAPSHOT_COMMANDS.has(subcommand) && result.exitCode === 0 && targetId) {
      snapshotPath = await autoSaveSnapshot(browser, fs, targetId, state);
    }

    try {
      await logSession(fs, state, {
        command: subcommand,
        args: subArgs,
        result,
        snapshotPath,
        targetId,
      });
    } catch {}

    return withContentionNote(browser, lockStatsBefore, contendedTargetId, result);
  });
}
