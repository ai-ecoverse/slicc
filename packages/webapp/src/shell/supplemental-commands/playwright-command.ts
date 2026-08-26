/**
 * playwright-cli — Playwright-compatible CLI for browser automation.
 *
 * Registered as `playwright-cli`, `playwright`, and `puppeteer`.
 * Uses BrowserAPI + VirtualFS injected from the shell options.
 *
 * This module is a thin dispatcher: it parses flags, looks up the requested
 * subcommand in the `playwrightHandlers` table, runs the handler under a shared
 * try/catch, then applies the common post-command logic (auto-snapshot +
 * session logging). Each subcommand handler lives under `playwright/handlers/`
 * and the shared helpers under `playwright/`.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { playwrightHandlers } from './playwright/handlers/index.js';
import { formatHelp, formatSubcommandHelp } from './playwright/help.js';
import { autoSaveSnapshot, logSession } from './playwright/session-log.js';
import {
  AUTO_SNAPSHOT_COMMANDS,
  frameIdUsedAsTabError,
  getSharedState,
  parseFlags,
} from './playwright/state.js';
import type { CmdResult, PlaywrightHandlerCtx } from './playwright/types.js';

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

/**
 * The browser port, taken from the handler context rather than imported from
 * `cdp/`: `playwright/types.ts` is the one module in this subtree that names
 * the CDP type, so the dispatcher stays inside the shell layer.
 */
type PlaywrightBrowser = PlaywrightHandlerCtx['browser'];

async function commandErrorResult(
  browser: PlaywrightBrowser,
  flags: Record<string, string>,
  err: unknown
): Promise<CmdResult> {
  const message = err instanceof Error ? err.message : String(err);
  const frameHint = flags['tab'] ? await frameIdUsedAsTabError(browser, flags['tab'], err) : null;
  return { stdout: '', stderr: `Error: ${frameHint ?? message}\n`, exitCode: 1 };
}

/**
 * Parse a subcommand's argv, answering `--help` and rejecting arguments the
 * subcommand does not support before any handler runs.
 *
 * Parsing comes first because it is what decides whether a `--help` token is a
 * help request or the VALUE of a value-taking flag (`route --body --help` mocks
 * a "--help" body; the shared parser shadows the value onto the flag, so
 * `flags.help` stays unset). Help is answered next, because `record` and `open`
 * default a missing URL to about:blank — asking for help used to open a tab.
 * Validation is last, so `<verb> --help` still explains a malformed call.
 */
async function parseSubcommandArgs(
  name: string,
  subcommand: string,
  subArgs: string[]
): Promise<{ positional: string[]; flags: Record<string, string> } | { answer: CmdResult }> {
  let positional: string[];
  let flags: Record<string, string>;
  try {
    ({ positional, flags } = parseFlags(subArgs));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { answer: { stdout: '', stderr: `${name} ${subcommand}: ${msg}\n`, exitCode: 1 } };
  }

  if (flags['help'] === 'true' || flags['h'] === 'true') {
    return {
      answer: { stdout: formatSubcommandHelp(name, subcommand), stderr: '', exitCode: 0 },
    };
  }

  // Unsupported flags/positionals are a caller bug: reject them here rather
  // than letting a handler silently ignore what it does not read (#2405).
  //
  // Loaded lazily — the validator and its ~9 kB manifest are dead weight in the
  // kernel worker's boot graph until a playwright-cli command runs. A failed
  // chunk load skips validation rather than failing the command: a validator
  // that cannot load must never be what stops a working call.
  let argError: string | null = null;
  try {
    const { validateSubcommandArgs } = await import('./playwright/validate-args.js');
    argError = validateSubcommandArgs(name, subcommand, subArgs, positional);
  } catch {
    argError = null;
  }
  if (argError) return { answer: { stdout: '', stderr: argError, exitCode: 1 } };

  return { positional, flags };
}

export function createPlaywrightCommand(
  name: string,
  browser: PlaywrightBrowser | null | undefined,
  fs: VirtualFS
): Command {
  const helpText = formatHelp(name);
  const state = browser ? getSharedState(browser, fs) : null;

  return defineCommand(name, async (args): Promise<CmdResult> => {
    if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
      return { stdout: helpText + '\n', stderr: '', exitCode: 0 };
    }

    const subcommand = args[0];
    const subArgs = args.slice(1);

    const parsed = await parseSubcommandArgs(name, subcommand, subArgs);
    if ('answer' in parsed) return parsed.answer;
    const { positional, flags } = parsed;

    if (!browser || !state) {
      return {
        stdout: '',
        stderr: `${name}: browser APIs are unavailable in this environment\n`,
        exitCode: 1,
      };
    }

    // Note: Per-tab teleport blocking is now handled within command handlers
    // via requireTab() -> browser.withTab() serialization

    let result: CmdResult;
    const handler = playwrightHandlers.get(subcommand);
    if (!handler) {
      result = {
        stdout: '',
        stderr: `Unknown command: ${subcommand}\nRun "playwright-cli help" for usage.\n`,
        exitCode: 1,
      };
    } else {
      try {
        result = await handler({ browser, fs, state, positional, flags });
      } catch (err) {
        result = await commandErrorResult(browser, flags, err);
      }
    }

    // Post-command: session logging + auto-snapshot
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
    } catch {
      // Session logging is best-effort — never fail the command
    }

    return result;
  });
}
