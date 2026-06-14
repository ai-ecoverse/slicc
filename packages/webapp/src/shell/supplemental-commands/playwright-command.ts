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
import type { BrowserAPI } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
import { playwrightHandlers } from './playwright/handlers/index.js';
import { formatHelp } from './playwright/help.js';
import { autoSaveSnapshot, logSession } from './playwright/session-log.js';
import { AUTO_SNAPSHOT_COMMANDS, getSharedState, parseFlags } from './playwright/state.js';
import type { CmdResult } from './playwright/types.js';

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

export function createPlaywrightCommand(
  name: string,
  browser: BrowserAPI | null | undefined,
  fs: VirtualFS
): Command {
  const helpText = formatHelp(name);
  const state = browser ? getSharedState(browser, fs) : null;

  return defineCommand(name, async (args): Promise<CmdResult> => {
    if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
      return { stdout: helpText + '\n', stderr: '', exitCode: 0 };
    }

    if (!browser || !state) {
      return {
        stdout: '',
        stderr: `${name}: browser APIs are unavailable in this environment\n`,
        exitCode: 1,
      };
    }

    const subcommand = args[0];
    const subArgs = args.slice(1);

    let positional: string[];
    let flags: Record<string, string>;
    try {
      ({ positional, flags } = parseFlags(subArgs));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `${name} ${subcommand}: ${msg}\n`, exitCode: 1 };
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
        const msg = err instanceof Error ? err.message : String(err);
        result = { stdout: '', stderr: `Error: ${msg}\n`, exitCode: 1 };
      }
    }

    // Post-command: session logging + auto-snapshot
    const targetId = flags['tab'] ?? null;
    let snapshotPath: string | null = null;

    if (AUTO_SNAPSHOT_COMMANDS.has(subcommand) && result.exitCode === 0 && targetId) {
      snapshotPath = await autoSaveSnapshot(browser, fs, targetId);
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
