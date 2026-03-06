import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function webhookHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: webhook <command> [options]

Commands:
  create [--name <name>] [--scoop <name>] [--filter <code>]   Create a new webhook endpoint
  list                                                         List all active webhooks
  delete <id>                                                  Delete a webhook by ID

Options:
  --scoop <name>    Route webhook events to this scoop (scoop receives events as messages)
  --filter <code>   JS filter function: (event) => false (drop), true (keep), or object (transform)
                    The event has: type, webhookId, webhookName, timestamp, headers, body

Examples:
  webhook create --name clicks --scoop click-handler
  webhook create --name github --scoop pr-reviewer --filter "(e) => e.body.action === 'opened'"
  webhook create --name slack --filter "(e) => ({ text: e.body.text, user: e.body.user })"
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

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  
  // In extension mode, we don't have a CLI server - webhooks not supported
  if (isExtension) {
    throw new Error('Webhooks are only available in CLI mode (npm run dev:full)');
  }

  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(`/api/webhooks${path}`, init);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
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

          const { ok, data } = await apiCall('POST', '', { name, filter, scoop });
          if (!ok) {
            return {
              stdout: '',
              stderr: `webhook: failed to create webhook: ${(data as { error?: string }).error ?? 'unknown error'}\n`,
              exitCode: 1,
            };
          }

          const info = data as WebhookInfo;
          let output = `Created webhook "${info.name}"\nID:  ${info.id}\nURL: ${info.url}\n`;
          if (info.scoop) {
            output += `Scoop: ${info.scoop}\n`;
          }
          if (info.filter) {
            output += `Filter: ${info.filter}\n`;
          }
          return {
            stdout: output,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'list': {
          const { ok, data } = await apiCall('GET', '');
          if (!ok) {
            return {
              stdout: '',
              stderr: `webhook: failed to list webhooks: ${(data as { error?: string }).error ?? 'unknown error'}\n`,
              exitCode: 1,
            };
          }

          const webhooks = data as WebhookInfo[];
          if (webhooks.length === 0) {
            return {
              stdout: 'No active webhooks\n',
              stderr: '',
              exitCode: 0,
            };
          }

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

          const { ok, status, data } = await apiCall('DELETE', `/${id}`);
          if (!ok) {
            if (status === 404) {
              return {
                stdout: '',
                stderr: `webhook: webhook "${id}" not found\n`,
                exitCode: 1,
              };
            }
            return {
              stdout: '',
              stderr: `webhook: failed to delete webhook: ${(data as { error?: string }).error ?? 'unknown error'}\n`,
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
