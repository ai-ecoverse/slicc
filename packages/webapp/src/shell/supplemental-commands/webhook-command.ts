import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getTrayWebhookUrl, getWebhookUrl } from '../../base/lick-urls.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import { defaultLickTarget, type LickTargetEnv } from '../lick-target-env.js';
import { getLickManagerSurface } from './lick-surface.js';
import { explicitLickTargetError } from './lick-target-check.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

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
  rotate                                                       Replace the cone's delivery secret (all webhook URLs)

Options:
  --scoop <target>  Scoop name, cone name, or folder. Omit for your own cone.
  --filter <code>   JS filter function: (event) => false (drop), true (keep), or object (transform)
                    The event has: type, webhookId, webhookName, timestamp, headers, body

Examples:
  webhook create --name inbox
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

const URL_UNAVAILABLE = '(URL unavailable — connect a leader tray)';

function resolveWebhookUrlBase(getLeaderStatus: () => WebhookLeaderStatus): string | null {
  return getLeaderStatus().session?.webhookUrl ?? null;
}

function buildWebhookUrl(
  webhookId: string,
  trayUrlBase: string | null,
  hasLocalNodeServer: () => boolean
): string {
  if (trayUrlBase) return getTrayWebhookUrl(trayUrlBase, webhookId);

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

async function handleRotate(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return { stdout: '', stderr: 'webhook rotate: takes no arguments\n', exitCode: 1 };
  }
  const rpc = getPanelRpcClient();
  if (!rpc) {
    return { stdout: '', stderr: 'webhook rotate: no leader panel connected\n', exitCode: 1 };
  }
  try {
    await rpc.call('tray-webhook-rotate', undefined);
    return {
      stdout:
        'Rotated webhook delivery secret. Old URLs no longer work; run webhook list for replacement URLs.\n',
      stderr: '',
      exitCode: 0,
    };
  } catch {
    return {
      stdout: '',
      stderr: 'webhook rotate: rotation failed; reconnect the leader and retry\n',
      exitCode: 1,
    };
  }
}

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

  const scoop = defaultLickTarget(parsed.values.get('--scoop'), env);

  if (!options.hasLocalNodeServer() && filter) {
    return {
      stdout: '',
      stderr:
        'webhook create: --filter is not supported in extension mode (CSP forbids dynamic eval) — drop --filter, or use standalone CLI mode\n',
      exitCode: 1,
    };
  }

  const preflightResult = validateExtensionWebhookPreconditions(options);
  if (preflightResult) return preflightResult;

  const lm = await getLickManagerSurface();
  if (!lm) return notInitializedError('create');

  const targetError = await explicitLickTargetError(
    lm,
    'webhook create',
    parsed.values.get('--scoop')
  );
  if (targetError) return { stdout: '', stderr: targetError, exitCode: 1 };

  const entry = await lm.createWebhook(name, scoop, filter);

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

async function handleDelete(
  args: string[],
  options: Required<WebhookCommandOptions>
): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) {
    return { stdout: '', stderr: `webhook delete: ${parsed.error}\n`, exitCode: 1 };
  }
  const id = parsed.positionals[0];
  if (parsed.positionals.length > 1) {
    return { stdout: '', stderr: 'webhook delete: requires exactly one ID\n', exitCode: 1 };
  }
  if (!id) {
    return {
      stdout: '',
      stderr: 'webhook delete: requires an ID\n',
      exitCode: 1,
    };
  }

  const lm = await getLickManagerSurface();
  if (!lm) return notInitializedError('delete');

  const rpc = getPanelRpcClient();
  try {
    if (rpc) {
      const result = await rpc.call('tray-webhook-revoke', { webhookId: id });
      if (result?.ok !== true) throw new Error('revocation not acknowledged');
    } else if (options.getLeaderStatus().session?.webhookUrl?.includes('/wh/')) {
      throw new Error('no leader panel');
    }
  } catch {
    return {
      stdout: '',
      stderr:
        'webhook delete: revocation failed; registration retained, reconnect the leader and retry\n',
      exitCode: 1,
    };
  }
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
    if (args.length === 0) {
      return webhookHelp();
    }

    const subcommand = args[0];
    if (
      isHelpRequest(args, {
        valueFlags: subcommand === 'create' ? CREATE_VALUE_FLAGS : undefined,
      })
    ) {
      return webhookHelp();
    }

    try {
      switch (subcommand) {
        case 'create':
          return await handleCreate(args, options, ctx.env);
        case 'list':
          return await handleList(args, options);
        case 'delete':
          return await handleDelete(args, options);
        case 'rotate':
          return await handleRotate(args);
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
