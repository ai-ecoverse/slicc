import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getTrayWebhookUrl, getWebhookUrl } from '../../base/lick-urls.js';
import { defaultLickTarget, type LickTargetEnv } from '../lick-target-env.js';
import { getLickManagerSurface } from './lick-surface.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

/** Value-taking flags for `webhook create` — shared with {@link isHelpRequest}. */
const CREATE_VALUE_FLAGS = ['--name', '--filter', '--scoop'] as const;

interface WebhookLeaderStatus {
  state: string;
  session: { webhookUrl: string } | null;
}

export interface WebhookCommandOptions {
  hasLocalNodeServer?: () => boolean;
  getLeaderStatus?: () => WebhookLeaderStatus;
}

const DEFAULT_LEADER_STATUS: WebhookLeaderStatus = { state: 'inactive', session: null };

function webhookHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: webhook <command> [options]

Commands:
  create [--scoop <name>] [--name <name>] [--filter <code>]  Create a new webhook endpoint
  list                                                         List all active webhooks
  delete <id>                                                  Delete a webhook by ID

Options:
  --scoop <target>  Scoop name, cone name, or folder. Required outside a cone.
  --filter <code>   JS filter function: (event) => false (drop), true (keep), or object (transform)
                    The event has: type, webhookId, webhookName, timestamp, headers, body

Examples:
  webhook create --scoop click-handler --name clicks
  webhook create --scoop pr-reviewer --name github --filter "(e) => e.body.action === 'opened'"
  webhook create --scoop slack-relay --name slack --filter "(e) => ({ text: e.body.text, user: e.body.user })"
  webhook list
  webhook delete abc123
`,
    stderr: '',
    exitCode: 0,
  };
}

interface WebhookInfo {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  filter?: string;
  scoop?: string;
}

/**
 * Sentinel rendered by `webhook list` in extension mode when no
 * leader-tray URL is available. `webhook create` short-circuits with a
 * stderr message earlier, so this string is only ever visible in the
 * list view.
 */
const URL_UNAVAILABLE = '(URL unavailable — connect a leader tray)';

/** Resolve the leader-tray webhook capability URL without the webhook ID suffix. */
function resolveWebhookUrlBase(getLeaderStatus: () => WebhookLeaderStatus): string | null {
  return getLeaderStatus().session?.webhookUrl ?? null;
}

/**
 * Build the per-webhook URL for the current runtime. Returns a non-
 * functional placeholder in extension mode when `trayUrlBase` is null,
 * because `self.location.origin` is `chrome-extension://<id>` which no
 * external POST can reach.
 */
function buildWebhookUrl(
  webhookId: string,
  trayUrlBase: string | null,
  hasLocalNodeServer: () => boolean
): string {
  // Tray-first in EVERY topology.
  if (trayUrlBase) return getTrayWebhookUrl(trayUrlBase, webhookId);
  // No tray: node-rest can still fall back to its local node-server origin; a
  // no-node-server float (extension-delegate / extension-direct) has no URL to
  // give, so surface the honest "connect a leader tray" message.
  if (!hasLocalNodeServer()) return URL_UNAVAILABLE;
  return getWebhookUrl(self.location.href, webhookId);
}

function notInitializedError(subcommand: string) {
  return {
    stdout: '',
    stderr: `webhook ${subcommand}: kernel host has not booted yet — try again in a moment\n`,
    exitCode: 1,
  };
}

type CommandResult = { stdout: string; stderr: string; exitCode: number };

async function handleCreate(
  args: string[],
  options: Required<WebhookCommandOptions>,
  env: LickTargetEnv
): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), { value: CREATE_VALUE_FLAGS });
  if ('error' in parsed) {
    return { stdout: '', stderr: `webhook create: ${parsed.error}\n`, exitCode: 1 };
  }

  const name = parsed.values.get('--name') ?? 'default';
  const filter = parsed.values.get('--filter');
  // No `--scoop`: a non-primary cone's shell names itself (SLICC_LICK_TARGET),
  // so `webhook create` inside an extra cone routes back to that cone (#2311).
  // The default root carries no such variable, so it still has to say where
  // the callbacks go — the pre-#2311 rule, unchanged for it.
  const scoop = defaultLickTarget(parsed.values.get('--scoop'), env);

  if (!scoop) {
    return {
      stdout: '',
      stderr:
        "webhook create: --scoop is required (name a scoop or a cone; an extra cone's shell supplies its own)\n",
      exitCode: 1,
    };
  }

  // Filter compilation requires dynamic JS evaluation; Chrome
  // extension CSP forbids it. crontask has the same gate. Users
  // who need filters should run standalone mode.
  if (!options.hasLocalNodeServer() && filter) {
    return {
      stdout: '',
      stderr:
        'webhook create: --filter is not supported in extension mode (CSP forbids dynamic eval) — drop --filter, or use standalone CLI mode\n',
      exitCode: 1,
    };
  }

  // Extension non-leader / no-tray: refuse — there's no public
  // webhook URL we can hand the user. Standalone falls through
  // and renders the local node-server URL.
  const preflightResult = validateExtensionWebhookPreconditions(options);
  if (preflightResult) return preflightResult;

  const lm = await getLickManagerSurface();
  if (!lm) return notInitializedError('create');
  const entry = await lm.createWebhook(name, scoop, filter);

  // Resolve URL after creation; if URL resolution fails, still
  // report the created webhook ID so the user can clean it up
  // rather than leaking a phantom entry.
  const url = resolveWebhookUrlSafe(entry.id, options);

  let output = `Created webhook "${entry.name}"\nID:  ${entry.id}\nURL: ${url}\n`;
  if (entry.scoop) output += `Scoop: ${entry.scoop}\n`;
  if (entry.filter) output += `Filter: ${entry.filter}\n`;
  return { stdout: output, stderr: '', exitCode: 0 };
}

async function handleList(
  args: string[],
  options: Required<WebhookCommandOptions>
): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) {
    return { stdout: '', stderr: `webhook list: ${parsed.error}\n`, exitCode: 1 };
  }

  const lm = await getLickManagerSurface();
  if (!lm) return notInitializedError('list');
  const entries = await lm.listWebhooks();

  if (entries.length === 0) {
    return { stdout: 'No active webhooks\n', stderr: '', exitCode: 0 };
  }

  // URL-base resolution can throw (proxy timeout, dynamic-
  // import failure) — fall back to `null` so the entries still
  // render with the `URL_UNAVAILABLE` sentinel rather than the
  // user seeing a list error and assuming webhooks are broken.
  const { trayUrlBase, urlResolutionError } = resolveUrlBaseWithFallback(options);
  const webhooks: WebhookInfo[] = entries.map((wh) => ({
    id: wh.id,
    name: wh.name,
    url: buildWebhookUrl(wh.id, trayUrlBase, options.hasLocalNodeServer),
    createdAt: wh.createdAt,
    filter: wh.filter,
    scoop: wh.scoop,
  }));

  return {
    stdout: formatWebhookList(
      webhooks,
      trayUrlBase,
      urlResolutionError,
      options.hasLocalNodeServer
    ),
    stderr: '',
    exitCode: 0,
  };
}

async function handleDelete(args: string[]): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) {
    return { stdout: '', stderr: `webhook delete: ${parsed.error}\n`, exitCode: 1 };
  }
  const id = parsed.positionals[0];
  if (!id) {
    return {
      stdout: '',
      stderr: 'webhook delete: requires an ID\n',
      exitCode: 1,
    };
  }

  const lm = await getLickManagerSurface();
  if (!lm) return notInitializedError('delete');
  const ok = await lm.deleteWebhook(id);

  if (!ok) {
    return {
      stdout: '',
      stderr: `webhook delete: webhook "${id}" not found\n`,
      exitCode: 1,
    };
  }

  return { stdout: `Deleted webhook "${id}"\n`, stderr: '', exitCode: 0 };
}

function validateExtensionWebhookPreconditions(
  options: Required<WebhookCommandOptions>
): CommandResult | null {
  if (options.hasLocalNodeServer()) return null;

  const urlBase = resolveWebhookUrlBase(options.getLeaderStatus);
  if (!urlBase) {
    const leaderState = options.getLeaderStatus().state;
    const msg =
      leaderState === 'leader'
        ? 'webhook create: tray session is not connected yet — wait for the leader to attach'
        : `webhook create: requires extension-leader mode with a tray worker URL configured (current state: "${leaderState}")`;
    return { stdout: '', stderr: msg + '\n', exitCode: 1 };
  }
  return null;
}

function resolveWebhookUrlSafe(
  webhookId: string,
  options: Required<WebhookCommandOptions>
): string {
  try {
    const trayUrlBase = resolveWebhookUrlBase(options.getLeaderStatus);
    return buildWebhookUrl(webhookId, trayUrlBase, options.hasLocalNodeServer);
  } catch (err) {
    return `(URL resolution failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function resolveUrlBaseWithFallback(options: Required<WebhookCommandOptions>): {
  trayUrlBase: string | null;
  urlResolutionError: string | null;
} {
  try {
    const trayUrlBase = resolveWebhookUrlBase(options.getLeaderStatus);
    return { trayUrlBase, urlResolutionError: null };
  } catch (err) {
    return {
      trayUrlBase: null,
      urlResolutionError: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatWebhookList(
  webhooks: WebhookInfo[],
  trayUrlBase: string | null,
  urlResolutionError: string | null,
  hasLocalNodeServer: () => boolean
): string {
  let output = 'Active webhooks:\n';
  for (const wh of webhooks) {
    output += `  ${wh.id}  ${wh.name.padEnd(20)}  ${wh.url}`;
    if (wh.scoop) output += `  -> ${wh.scoop}`;
    if (wh.filter) output += `  [filtered]`;
    output += '\n';
  }
  if (urlResolutionError) {
    output += `\nNote: webhook URL resolution failed (${urlResolutionError}). Try again once the tray is connected.\n`;
  } else if (!hasLocalNodeServer() && !trayUrlBase) {
    // Extension mode without a leader tray: explain the
    // URL_UNAVAILABLE rows so the user isn't guessing.
    output += `\nNote: webhook URLs require a leader tray. Configure one in Settings to expose POST endpoints.\n`;
  }
  return output;
}

export function createWebhookCommand(commandOptions: WebhookCommandOptions = {}): Command {
  const options: Required<WebhookCommandOptions> = {
    hasLocalNodeServer: commandOptions.hasLocalNodeServer ?? (() => true),
    getLeaderStatus: commandOptions.getLeaderStatus ?? (() => DEFAULT_LEADER_STATUS),
  };
  return defineCommand('webhook', async (args, ctx) => {
    if (args.length === 0 || isHelpRequest(args, { valueFlags: CREATE_VALUE_FLAGS })) {
      return webhookHelp();
    }

    const subcommand = args[0];

    try {
      switch (subcommand) {
        case 'create':
          return await handleCreate(args, options, ctx.env);
        case 'list':
          return await handleList(args, options);
        case 'delete':
          return await handleDelete(args);
        default:
          return {
            stdout: '',
            stderr: `webhook: unknown command "${subcommand}"\n`,
            exitCode: 1,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: `webhook ${subcommand ?? '?'}: ${msg}\n`,
        exitCode: 1,
      };
    }
  });
}
