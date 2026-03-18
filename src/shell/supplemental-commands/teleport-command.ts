/**
 * `teleport` shell command — teleport cookies from a remote tray runtime's browser
 * to the local browser, enabling seamless authentication transfer.
 *
 * Usage:
 *   teleport                    # Auto-select best follower, teleport cookies
 *   teleport <runtime-id>       # Teleport cookies from a specific runtime
 *   teleport --list              # List available runtimes for teleport
 *
 * Flags:
 *   --list, -l             List available runtimes for teleport
 *   --reload, -r           Reload the active tab after applying cookies (default: true)
 *   --no-reload            Don't reload the active tab after applying cookies
 *   --catch <regex>        Capture cookies when the URL MATCHES the regex
 *   --catch-not <regex>    Capture cookies when the URL NO LONGER MATCHES the regex
 *   --help, -h             Show usage
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import type { BrowserAPI } from '../../cdp/index.js';
import type { CookieTeleportCookie } from '../../scoops/tray-sync-protocol.js';
import type { FloatType } from '../../scoops/tray-leader-sync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SendCookieTeleportRequestFn = (targetRuntimeId: string, url?: string, catchPattern?: string, catchNotPattern?: string, timeoutMs?: number) => Promise<{ cookies: CookieTeleportCookie[]; timedOut?: boolean }>;

export type GetBestFollowerForTeleportFn = () => { runtimeId: string; bootstrapId: string; floatType: FloatType } | null;

export interface ConnectedFollowerForTeleport {
  runtimeId: string;
  runtime?: string;
  connectedAt?: string;
  lastActivity?: number;
  floatType?: FloatType;
}

export type GetConnectedFollowersFn = () => ConnectedFollowerForTeleport[];

// ---------------------------------------------------------------------------
// Module-level callbacks (same pattern as host-command.ts / rsync-command.ts)
// ---------------------------------------------------------------------------

let sendCookieTeleportRequestGetter: (() => SendCookieTeleportRequestFn | null) | null = null;
let getBestFollowerForTeleportGetter: (() => GetBestFollowerForTeleportFn | null) | null = null;
let getConnectedFollowersForTeleportGetter: (() => GetConnectedFollowersFn | null) | null = null;
let browserAPIGetter: (() => BrowserAPI | null) | null = null;

export function setTeleportSendRequest(getter: (() => SendCookieTeleportRequestFn | null) | null): void {
  sendCookieTeleportRequestGetter = getter;
}

export function setTeleportBestFollower(getter: (() => GetBestFollowerForTeleportFn | null) | null): void {
  getBestFollowerForTeleportGetter = getter;
}

export function setTeleportConnectedFollowers(getter: (() => GetConnectedFollowersFn | null) | null): void {
  getConnectedFollowersForTeleportGetter = getter;
}

export function setTeleportBrowserAPI(getter: (() => BrowserAPI | null) | null): void {
  browserAPIGetter = getter;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function teleportHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `teleport — teleport cookies from a remote tray runtime's browser

Usage:
  teleport                      Auto-select best follower, teleport cookies
  teleport <runtime-id>         Teleport cookies from a specific runtime
  teleport --url <url>          Open URL for interactive auth before capturing
  teleport --list               List available runtimes for teleport

Flags:
  --list, -l              List available runtimes for teleport
  --url <url>             Open a browser tab on the follower for interactive auth
  --catch <regex>         Capture cookies when the URL MATCHES the regex
  --catch-not <regex>     Capture cookies when the URL NO LONGER MATCHES the regex
  --timeout <seconds>     Auth flow timeout (default: 300, only with --url)
  --reload, -r            Reload the active tab after applying cookies (default)
  --no-reload             Don't reload the active tab after applying cookies
  --help, -h              Show this help

The teleport command captures all browser cookies from a remote runtime
in the tray and applies them to the local browser, enabling seamless
authentication transfer between SLICC instances.

When --url is provided, the follower opens a browser tab for the human
to complete login. By default, cookies are captured when the browser
returns to the initial hostname (SSO redirect heuristic).

Use --catch or --catch-not (mutually exclusive) to override the default:
  --catch <regex>       Complete when URL matches the pattern
  --catch-not <regex>   Complete when URL stops matching the pattern
                        (skips the first navigation to avoid false positives)
`,
    stderr: '',
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedTeleportArgs {
  targetRuntimeId?: string;
  url?: string;
  catchPattern?: string;
  catchNotPattern?: string;
  timeout?: number;
  list: boolean;
  reload: boolean;
}

export function parseTeleportArgs(args: string[]): ParsedTeleportArgs | { error: string } {
  let list = false;
  let reload = true;
  let url: string | undefined;
  let catchPattern: string | undefined;
  let catchNotPattern: string | undefined;
  let timeout: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { error: '__help__' };
    if (arg === '--list' || arg === '-l') { list = true; continue; }
    if (arg === '--reload' || arg === '-r') { reload = true; continue; }
    if (arg === '--no-reload') { reload = false; continue; }
    if (arg === '--url') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) return { error: '--url requires a URL argument' };
      url = next;
      i++;
      continue;
    }
    if (arg === '--timeout') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) return { error: '--timeout requires a number (seconds)' };
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) return { error: `--timeout must be a positive number: ${next}` };
      timeout = parsed;
      i++;
      continue;
    }
    if (arg === '--catch') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) return { error: '--catch requires a regex argument' };
      try { new RegExp(next); } catch { return { error: `Invalid regex for --catch: ${next}` }; }
      catchPattern = next;
      i++;
      continue;
    }
    if (arg === '--catch-not') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) return { error: '--catch-not requires a regex argument' };
      try { new RegExp(next); } catch { return { error: `Invalid regex for --catch-not: ${next}` }; }
      catchNotPattern = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) return { error: `Unknown flag: ${arg}` };
    positional.push(arg);
  }

  if (positional.length > 1) {
    return { error: 'Expected at most 1 argument: <runtime-id>' };
  }

  if (catchPattern && catchNotPattern) {
    return { error: '--catch and --catch-not are mutually exclusive' };
  }

  return { targetRuntimeId: positional[0], url, catchPattern, catchNotPattern, timeout, list, reload };
}

// ---------------------------------------------------------------------------
// List runtimes
// ---------------------------------------------------------------------------

function formatRuntimeList(followers: ConnectedFollowerForTeleport[]): string {
  if (followers.length === 0) {
    return 'No followers connected to the tray.\n';
  }
  const lines = ['Available runtimes for teleport:'];
  for (const f of followers) {
    const parts = [f.runtimeId];
    if (f.floatType) parts.push(`[${f.floatType}]`);
    if (f.runtime) parts.push(`(${f.runtime})`);
    if (f.lastActivity) {
      const ago = Math.round((Date.now() - f.lastActivity) / 1000);
      parts.push(`active ${ago}s ago`);
    }
    lines.push(`  ${parts.join(' ')}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createTeleportCommand(): Command {
  return defineCommand('teleport', async (args) => {
    if (args.includes('--help') || args.includes('-h') || args.length === 0 && !sendCookieTeleportRequestGetter) {
      // If no getter is available and no args, show help
    }

    const parsed = parseTeleportArgs(args);
    if ('error' in parsed) {
      if (parsed.error === '__help__') return teleportHelp();
      return { stdout: '', stderr: `teleport: ${parsed.error}\n`, exitCode: 1 };
    }

    // --list mode
    if (parsed.list) {
      const getFollowers = getConnectedFollowersForTeleportGetter?.();
      if (!getFollowers) {
        return { stdout: '', stderr: 'teleport: not connected to a tray\n', exitCode: 1 };
      }
      return { stdout: formatRuntimeList(getFollowers()), stderr: '', exitCode: 0 };
    }

    // Teleport mode
    const sendRequest = sendCookieTeleportRequestGetter?.();
    if (!sendRequest) {
      return { stdout: '', stderr: 'teleport: not connected to a tray — teleport requires a tray connection\n', exitCode: 1 };
    }

    const browser = browserAPIGetter?.();
    if (!browser) {
      return { stdout: '', stderr: 'teleport: no browser available\n', exitCode: 1 };
    }

    // Determine target runtime
    let targetRuntimeId = parsed.targetRuntimeId;
    if (!targetRuntimeId) {
      const getBestFollower = getBestFollowerForTeleportGetter?.();
      if (!getBestFollower) {
        return { stdout: '', stderr: 'teleport: cannot auto-select — no follower selection available\n', exitCode: 1 };
      }
      const best = getBestFollower();
      if (!best) {
        return { stdout: '', stderr: 'teleport: no followers connected to teleport from\n', exitCode: 1 };
      }
      targetRuntimeId = best.runtimeId;
    }

    try {
      // 1. Request cookies from the remote runtime
      // When --url is used, apply a timeout (default 120s) with a caller-side
      // safety margin (+10s) to prevent indefinite hangs even if the follower
      // becomes disconnected.
      const timeoutMs = parsed.url ? (parsed.timeout ?? 300) * 1000 : undefined;
      const callerTimeoutMs = timeoutMs ? timeoutMs + 10_000 : undefined;

      console.log('[teleport-debug] sending request', { targetRuntimeId, url: parsed.url, catchPattern: parsed.catchPattern, catchNotPattern: parsed.catchNotPattern, timeoutMs, callerTimeoutMs });

      const requestPromise = sendRequest(targetRuntimeId, parsed.url, parsed.catchPattern, parsed.catchNotPattern, timeoutMs);
      const { cookies, timedOut } = callerTimeoutMs
        ? await Promise.race([
            requestPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => {
                console.log('[teleport-debug] CALLER TIMEOUT fired', { callerTimeoutMs });
                reject(new Error(`Teleport timed out after ${Math.round(callerTimeoutMs / 1000)}s`));
              }, callerTimeoutMs),
            ),
          ])
        : await requestPromise;
      console.log('[teleport-debug] request resolved', { cookieCount: cookies.length, timedOut });
      if (cookies.length === 0) {
        if (timedOut) {
          return { stdout: `Teleport timed out \u2014 no cookies captured from ${targetRuntimeId}\n`, stderr: '', exitCode: 1 };
        }
        return { stdout: `No cookies on runtime ${targetRuntimeId}\n`, stderr: '', exitCode: 0 };
      }

      // 2. Apply cookies to the local browser via Network.setCookies
      const transport = browser.getTransport();
      // Need to find the active page to attach CDP
      const pages = await browser.listPages();
      if (pages.length === 0) {
        return { stdout: '', stderr: 'teleport: no local tabs available to apply cookies to\n', exitCode: 1 };
      }
      // Prefer the active page, otherwise use the first one
      const activePage = pages.find(p => p.active) ?? pages[0];
      await browser.attachToPage(activePage.targetId);

      await browser.sendCDP('Network.setCookies', { cookies });

      // 3. Optionally reload
      if (parsed.reload) {
        await browser.sendCDP('Page.reload', {});
      }

      const timeoutNote = timedOut ? ' (timed out, partial capture)' : '';
      return {
        stdout: `Teleported ${cookies.length} cookie(s) from ${targetRuntimeId}${parsed.reload ? ' (page reloaded)' : ''}${timeoutNote}\n`,
        stderr: '',
        exitCode: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `teleport: ${msg}\n`, exitCode: 1 };
    }
  });
}
