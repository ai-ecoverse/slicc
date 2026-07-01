import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { hasLocalNodeServer } from '../../core/float-topology.js';
import { getLeaderStatusWithFallback } from '../../scoops/tray-leader.js';
import { getTrayWebhookUrl, getWebhookUrl } from '../../ui/runtime-mode.js';

function webhookHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: webhook <command> [options]

Commands:
  create --scoop <name> [--name <name>] [--filter <code>]    Create a new webhook endpoint
  list                                                         List all active webhooks
  delete <id>                                                  Delete a webhook by ID

Options:
  --scoop <name>    Route webhook events to this scoop (required; scoop receives events as messages)
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

/** Get the LickManager from globalThis (published by `createKernelHost`). */
function getDirectLickManager(): import('../../scoops/lick-manager.js').LickManager | null {
  return (
    ((globalThis as unknown as Record<string, unknown>).__slicc_lickManager as
      | import('../../scoops/lick-manager.js').LickManager
      | null) ?? null
  );
}

/** Side-panel terminal doesn't have direct access to the offscreen
 * LickManager singleton — proxy through BroadcastChannel instead. */
let LickProxy: ReturnType<
  typeof import('../../../../chrome-extension/src/lick-manager-proxy.js').createLickManagerProxy
> | null = null;
async function getLickProxy() {
  if (LickProxy) return LickProxy;
  const { createLickManagerProxy } = await import(
    '../../../../chrome-extension/src/lick-manager-proxy.js'
  );
  LickProxy = createLickManagerProxy();
  return LickProxy;
}

/**
 * Resolve the leader-tray webhook capability URL base (without the
 * per-webhook id suffix), or `null` when no leader-tray URL exists in
 * the current runtime. Returns:
 * - extension leader with active session → the cloudflare tray worker's
 *   webhook capability URL (`<workerBaseUrl>/webhook/<token>`).
 * - extension follower / no-tray / leader-without-session → `null`.
 * - standalone with active leader tray → the tray URL.
 * - standalone without a leader tray → `null` (caller falls back to the
 *   local node-server URL via `getWebhookUrl(self.location.href, id)`).
 */
async function resolveWebhookUrlBase(): Promise<string | null> {
  // Direct/worker path (standalone, hosted, extension-delegate leader). The
  // leader tray may run on the PAGE while this runs in the WORKER (whose tray
  // module global stays `inactive`), so use the shim-aware fallback — same
  // precedent as the `/licks-ws` `tray_status` handler.
  if (getDirectLickManager()) {
    return getLeaderStatusWithFallback().session?.webhookUrl ?? null;
  }
  // No direct manager → legacy side-panel proxy path (unused in the current
  // single-kernel-worker leader tab; kept until confirmed removable).
  const { getTrayWebhookUrlAsync } = await import(
    '../../../../chrome-extension/src/lick-manager-proxy.js'
  );
  return await getTrayWebhookUrlAsync();
}

/**
 * Build the per-webhook URL for the current runtime. Returns a non-
 * functional placeholder in extension mode when `trayUrlBase` is null,
 * because `self.location.origin` is `chrome-extension://<id>` which no
 * external POST can reach.
 */
function buildWebhookUrl(webhookId: string, trayUrlBase: string | null): string {
  // Tray-first in EVERY topology.
  if (trayUrlBase) return getTrayWebhookUrl(trayUrlBase, webhookId);
  // No tray: node-rest can still fall back to its local node-server origin; a
  // no-node-server float (extension-delegate / extension-direct) has no URL to
  // give, so surface the honest "connect a leader tray" message.
  if (!hasLocalNodeServer()) return URL_UNAVAILABLE;
  return getWebhookUrl(self.location.href, webhookId);
}

/**
 * Return the configured manager surface. In standalone the kernel-host
 * singleton is the source of truth; in extension we fall back to the
 * BroadcastChannel proxy.
 *
 * Returns null only in standalone if the kernel host hasn't booted yet
 * — callers surface a clear "kernel host has not booted" error rather
 * than letting the (irrelevant in standalone) proxy timeout eat 5s.
 * Extension callers always get a proxy-backed surface; the offscreen
 * document may still be booting / unloaded, and that case manifests as
 * the proxy's 5s timeout (named per-op via the proxy's error message).
 */
async function getLickManagerSurface(): Promise<{
  createWebhook: (
    name: string,
    scoop?: string,
    filter?: string
  ) => Promise<import('../../scoops/lick-manager.js').WebhookEntry>;
  deleteWebhook: (id: string) => Promise<boolean>;
  listWebhooks: () => Promise<import('../../scoops/lick-manager.js').WebhookEntry[]>;
} | null> {
  const direct = getDirectLickManager();
  if (direct) {
    return {
      createWebhook: (name, scoop?, filter?) => direct.createWebhook(name, scoop, filter),
      deleteWebhook: (id) => direct.deleteWebhook(id),
      listWebhooks: async () => direct.listWebhooks(),
    };
  }
  if (hasLocalNodeServer()) return null;
  const proxy = await getLickProxy();
  const { listWebhooksAsync } = await import(
    '../../../../chrome-extension/src/lick-manager-proxy.js'
  );
  return {
    createWebhook: (name, scoop?, filter?) => proxy.createWebhook(name, scoop, filter),
    deleteWebhook: (id) => proxy.deleteWebhook(id),
    listWebhooks: () => listWebhooksAsync(),
  };
}

function notInitializedError(subcommand: string) {
  return {
    stdout: '',
    stderr: `webhook ${subcommand}: kernel host has not booted yet — try again in a moment\n`,
    exitCode: 1,
  };
}

type CommandResult = { stdout: string; stderr: string; exitCode: number };

async function handleCreate(args: string[]): Promise<CommandResult> {
  let name = 'default';
  let filter: string | undefined;
  let scoop: string | undefined;

  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    name = args[nameIdx + 1];
  }

  const filterIdx = args.indexOf('--filter');
  if (filterIdx !== -1 && args[filterIdx + 1]) {
    filter = args[filterIdx + 1];
  }

  const scoopIdx = args.indexOf('--scoop');
  if (scoopIdx !== -1 && args[scoopIdx + 1]) {
    scoop = args[scoopIdx + 1];
  }

  if (!scoop) {
    return {
      stdout: '',
      stderr: 'webhook create: --scoop is required (every webhook must route to a scoop)\n',
      exitCode: 1,
    };
  }

  // Filter compilation requires dynamic JS evaluation; Chrome
  // extension CSP forbids it. crontask has the same gate. Users
  // who need filters should run standalone mode.
  if (!hasLocalNodeServer() && filter) {
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
  const preflightResult = await validateExtensionWebhookPreconditions();
  if (preflightResult) return preflightResult;

  const lm = await getLickManagerSurface();
  if (!lm) return notInitializedError('create');
  const entry = await lm.createWebhook(name, scoop, filter);

  // Resolve URL after creation; if URL resolution fails, still
  // report the created webhook ID so the user can clean it up
  // rather than leaking a phantom entry.
  const url = await resolveWebhookUrlSafe(entry.id);

  let output = `Created webhook "${entry.name}"\nID:  ${entry.id}\nURL: ${url}\n`;
  if (entry.scoop) output += `Scoop: ${entry.scoop}\n`;
  if (entry.filter) output += `Filter: ${entry.filter}\n`;
  return { stdout: output, stderr: '', exitCode: 0 };
}

async function handleList(): Promise<CommandResult> {
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
  const { trayUrlBase, urlResolutionError } = await resolveUrlBaseWithFallback();
  const webhooks: WebhookInfo[] = entries.map((wh) => ({
    id: wh.id,
    name: wh.name,
    url: buildWebhookUrl(wh.id, trayUrlBase),
    createdAt: wh.createdAt,
    filter: wh.filter,
    scoop: wh.scoop,
  }));

  return {
    stdout: formatWebhookList(webhooks, trayUrlBase, urlResolutionError),
    stderr: '',
    exitCode: 0,
  };
}

async function handleDelete(args: string[]): Promise<CommandResult> {
  const id = args[1];
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

async function validateExtensionWebhookPreconditions(): Promise<CommandResult | null> {
  if (hasLocalNodeServer()) return null;

  const urlBase = await resolveWebhookUrlBase();
  if (!urlBase) {
    const leaderState = getLeaderStatusWithFallback().state;
    const msg =
      leaderState === 'leader'
        ? 'webhook create: tray session is not connected yet — wait for the leader to attach'
        : `webhook create: requires extension-leader mode with a tray worker URL configured (current state: "${leaderState}")`;
    return { stdout: '', stderr: msg + '\n', exitCode: 1 };
  }
  return null;
}

async function resolveWebhookUrlSafe(webhookId: string): Promise<string> {
  try {
    const trayUrlBase = await resolveWebhookUrlBase();
    return buildWebhookUrl(webhookId, trayUrlBase);
  } catch (err) {
    return `(URL resolution failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function resolveUrlBaseWithFallback(): Promise<{
  trayUrlBase: string | null;
  urlResolutionError: string | null;
}> {
  try {
    const trayUrlBase = await resolveWebhookUrlBase();
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
  urlResolutionError: string | null
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

export function createWebhookCommand(): Command {
  return defineCommand('webhook', async (args) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return webhookHelp();
    }

    const subcommand = args[0];

    try {
      switch (subcommand) {
        case 'create':
          return await handleCreate(args);
        case 'list':
          return await handleList();
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
