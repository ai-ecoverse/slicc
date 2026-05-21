import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { getTrayWebhookUrl, getWebhookUrl } from '../../ui/runtime-mode.js';
import { getLeaderTrayRuntimeStatus } from '../../scoops/tray-leader.js';

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

const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

/** Get the LickManager from globalThis (published by `createKernelHost`). */
function getDirectLickManager(): import('../../scoops/lick-manager.js').LickManager | null {
  return (
    ((globalThis as unknown as Record<string, unknown>).__slicc_lickManager as
      | import('../../scoops/lick-manager.js').LickManager
      | null) ?? null
  );
}

/** Lazy-loaded proxy for when the command runs in the side panel terminal. */
let _lickProxy: ReturnType<
  typeof import('../../../../chrome-extension/src/lick-manager-proxy.js').createLickManagerProxy
> | null = null;
async function getLickProxy() {
  if (_lickProxy) return _lickProxy;
  const { createLickManagerProxy } =
    await import('../../../../chrome-extension/src/lick-manager-proxy.js');
  _lickProxy = createLickManagerProxy();
  return _lickProxy;
}

/**
 * Resolve the webhook capability URL base for the current runtime
 * (without the per-webhook id suffix). Returns:
 * - extension leader → the cloudflare tray worker's webhook capability
 *   URL (`<workerBaseUrl>/webhook/<token>`).
 * - extension follower / no-tray / not leader → `null` (caller refuses).
 * - standalone → `null` (caller falls back to the local node-server URL
 *   via `getWebhookUrl(self.location.href, id)`).
 */
async function resolveWebhookUrlBase(): Promise<string | null> {
  if (!isExtension) {
    // Standalone reads the in-worker leader status synchronously; the
    // tray session lives on the same globalThis as the LickManager.
    return getLeaderTrayRuntimeStatus().session?.webhookUrl ?? null;
  }
  // Offscreen kernel context: read the singleton directly.
  if (getDirectLickManager()) {
    return getLeaderTrayRuntimeStatus().session?.webhookUrl ?? null;
  }
  // Side-panel terminal: proxy to offscreen.
  const { getTrayWebhookUrlAsync } =
    await import('../../../../chrome-extension/src/lick-manager-proxy.js');
  return await getTrayWebhookUrlAsync();
}

/** Build the per-webhook URL for a given runtime. */
function buildWebhookUrl(webhookId: string, trayUrlBase: string | null): string {
  if (trayUrlBase) return getTrayWebhookUrl(trayUrlBase, webhookId);
  return getWebhookUrl(self.location.href, webhookId);
}

export function createWebhookCommand(): Command {
  return defineCommand('webhook', async (args) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return webhookHelp();
    }

    const subcommand = args[0];

    try {
      switch (subcommand) {
        case 'create': {
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
              stderr: 'webhook: --scoop is required (every webhook must route to a scoop)\n',
              exitCode: 1,
            };
          }

          // Filter compilation requires dynamic JS evaluation; Chrome
          // extension CSP forbids it. crontask has the same gate.
          if (isExtension && filter) {
            return {
              stdout: '',
              stderr: 'webhook: --filter is not supported in extension mode (CSP restriction)\n',
              exitCode: 1,
            };
          }

          // Extension follower / no-tray refusal — only fires in
          // extension mode; standalone reaches the node-server over the
          // /licks-ws bridge instead.
          if (isExtension) {
            const urlBase = await resolveWebhookUrlBase();
            if (!urlBase) {
              const leaderState = getLeaderTrayRuntimeStatus().state;
              const msg =
                leaderState === 'leader'
                  ? 'webhook: tray session is not connected yet — wait for the leader to attach'
                  : 'webhook: requires extension-leader mode with a tray worker URL configured (this device is currently in state "' +
                    leaderState +
                    '")';
              return {
                stdout: '',
                stderr: msg + '\n',
                exitCode: 1,
              };
            }
          }

          const direct = getDirectLickManager();
          const entry = direct
            ? await direct.createWebhook(name, scoop, filter)
            : await (await getLickProxy()).createWebhook(name, scoop, filter);

          const trayUrlBase = await resolveWebhookUrlBase();
          const url = buildWebhookUrl(entry.id, trayUrlBase);

          let output = `Created webhook "${entry.name}"\nID:  ${entry.id}\nURL: ${url}\n`;
          if (entry.scoop) {
            output += `Scoop: ${entry.scoop}\n`;
          }
          if (entry.filter) {
            output += `Filter: ${entry.filter}\n`;
          }
          return {
            stdout: output,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'list': {
          const direct = getDirectLickManager();
          let entries: import('../../scoops/lick-manager.js').WebhookEntry[];
          if (direct) {
            entries = direct.listWebhooks();
          } else if (isExtension) {
            const { listWebhooksAsync } =
              await import('../../../../chrome-extension/src/lick-manager-proxy.js');
            entries = await listWebhooksAsync();
          } else {
            // Standalone always has direct access. If we got here the
            // host hasn't booted yet — surface that rather than silently
            // returning empty.
            return {
              stdout: '',
              stderr: 'webhook: LickManager is not initialized yet\n',
              exitCode: 1,
            };
          }

          if (entries.length === 0) {
            return {
              stdout: 'No active webhooks\n',
              stderr: '',
              exitCode: 0,
            };
          }

          const trayUrlBase = await resolveWebhookUrlBase();
          const webhooks: WebhookInfo[] = entries.map((wh) => ({
            id: wh.id,
            name: wh.name,
            url: buildWebhookUrl(wh.id, trayUrlBase),
            createdAt: wh.createdAt,
            filter: wh.filter,
            scoop: wh.scoop,
          }));

          let output = 'Active webhooks:\n';
          for (const wh of webhooks) {
            output += `  ${wh.id}  ${wh.name.padEnd(20)}  ${wh.url}`;
            if (wh.scoop) {
              output += `  -> ${wh.scoop}`;
            }
            if (wh.filter) {
              output += `  [filtered]`;
            }
            output += '\n';
          }
          return {
            stdout: output,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'delete': {
          const id = args[1];
          if (!id) {
            return {
              stdout: '',
              stderr: 'webhook: delete requires an ID\n',
              exitCode: 1,
            };
          }

          const direct = getDirectLickManager();
          const ok = direct
            ? await direct.deleteWebhook(id)
            : await (await getLickProxy()).deleteWebhook(id);

          if (!ok) {
            return {
              stdout: '',
              stderr: `webhook: webhook "${id}" not found\n`,
              exitCode: 1,
            };
          }

          return {
            stdout: `Deleted webhook "${id}"\n`,
            stderr: '',
            exitCode: 0,
          };
        }

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
        stderr: `webhook: ${msg}\n`,
        exitCode: 1,
      };
    }
  });
}
