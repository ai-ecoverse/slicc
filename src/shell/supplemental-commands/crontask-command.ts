import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function crontaskHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: crontask <command> [options]

Commands:
  create [options]   Create a new cron task
  list               List all active cron tasks
  delete <id>        Delete a cron task by ID
  kill <id>          Alias for delete

Options:
  --name <name>     Name for the cron task (required)
  --scoop <name>    Route cron events to this scoop (scoop receives events as licks)
  --cron <expr>     Cron expression: "min hour day month weekday" (required)
  --filter <code>   JS filter function: () => false (skip), true (run), or object (payload)
                    Called on each tick to decide whether to dispatch

Cron Expression:
  ┌───────────── minute (0-59)
  │ ┌───────────── hour (0-23)
  │ │ ┌───────────── day of month (1-31)
  │ │ │ ┌───────────── month (1-12)
  │ │ │ │ ┌───────────── day of week (0-6, Sun=0)
  │ │ │ │ │
  * * * * *

  Special characters: * (any), - (range), , (list), / (step)

Examples:
  crontask create --name hourly-check --scoop monitor --cron "0 * * * *"
  crontask create --name workday-9am --scoop alerts --cron "0 9 * * 1-5"
  crontask create --name every-5min --scoop poller --cron "*/5 * * * *" --filter "() => ({ time: Date.now() })"
  crontask list
  crontask delete abc123
`,
    stderr: '',
    exitCode: 0,
  };
}

interface CronTaskInfo {
  id: string;
  name: string;
  cron: string;
  scoop?: string;
  filter?: string;
  nextRun?: string;
  lastRun?: string;
  status: string;
  createdAt: string;
}

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

  // In extension mode, we don't have a CLI server - crontasks not supported
  if (isExtension) {
    throw new Error('Cron tasks are only available in CLI mode (npm run dev:full)');
  }

  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(`/api/crontasks${path}`, init);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export function createCrontaskCommand(): Command {
  return defineCommand('crontask', async (args) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return crontaskHelp();
    }

    const subcommand = args[0];

    try {
      switch (subcommand) {
        case 'create': {
          let name: string | undefined;
          let cron: string | undefined;
          let filter: string | undefined;
          let scoop: string | undefined;

          const nameIdx = args.indexOf('--name');
          if (nameIdx !== -1 && args[nameIdx + 1]) {
            name = args[nameIdx + 1];
          }

          const cronIdx = args.indexOf('--cron');
          if (cronIdx !== -1 && args[cronIdx + 1]) {
            cron = args[cronIdx + 1];
          }

          const filterIdx = args.indexOf('--filter');
          if (filterIdx !== -1 && args[filterIdx + 1]) {
            filter = args[filterIdx + 1];
          }

          const scoopIdx = args.indexOf('--scoop');
          if (scoopIdx !== -1 && args[scoopIdx + 1]) {
            scoop = args[scoopIdx + 1];
          }

          if (!name) {
            return {
              stdout: '',
              stderr: 'crontask: --name is required\n',
              exitCode: 1,
            };
          }

          if (!cron) {
            return {
              stdout: '',
              stderr: 'crontask: --cron is required\n',
              exitCode: 1,
            };
          }

          const { ok, data } = await apiCall('POST', '', { name, cron, filter, scoop });
          if (!ok) {
            return {
              stdout: '',
              stderr: `crontask: failed to create: ${(data as { error?: string }).error ?? 'unknown error'}\n`,
              exitCode: 1,
            };
          }

          const info = data as CronTaskInfo;
          let output = `Created cron task "${info.name}"\n`;
          output += `ID:       ${info.id}\n`;
          output += `Cron:     ${info.cron}\n`;
          if (info.scoop) {
            output += `Scoop:    ${info.scoop}\n`;
          }
          if (info.filter) {
            output += `Filter:   ${info.filter}\n`;
          }
          if (info.nextRun) {
            output += `Next run: ${new Date(info.nextRun).toLocaleString()}\n`;
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
              stderr: `crontask: failed to list: ${(data as { error?: string }).error ?? 'unknown error'}\n`,
              exitCode: 1,
            };
          }

          const tasks = data as CronTaskInfo[];
          if (tasks.length === 0) {
            return {
              stdout: 'No active cron tasks\n',
              stderr: '',
              exitCode: 0,
            };
          }

          let output = 'Active cron tasks:\n';
          for (const task of tasks) {
            output += `  ${task.id}  ${task.name.padEnd(20)}  ${task.cron.padEnd(15)}`;
            if (task.scoop) {
              output += `  -> ${task.scoop}`;
            }
            if (task.filter) {
              output += `  [filtered]`;
            }
            output += `  (${task.status})`;
            if (task.nextRun) {
              output += `  next: ${new Date(task.nextRun).toLocaleString()}`;
            }
            output += '\n';
          }
          return {
            stdout: output,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'delete':
        case 'kill': {
          const id = args[1];
          if (!id) {
            return {
              stdout: '',
              stderr: `crontask: ${subcommand} requires an ID\n`,
              exitCode: 1,
            };
          }

          const { ok, status, data } = await apiCall('DELETE', `/${id}`);
          if (!ok) {
            if (status === 404) {
              return {
                stdout: '',
                stderr: `crontask: task "${id}" not found\n`,
                exitCode: 1,
              };
            }
            return {
              stdout: '',
              stderr: `crontask: failed to delete: ${(data as { error?: string }).error ?? 'unknown error'}\n`,
              exitCode: 1,
            };
          }

          return {
            stdout: `Deleted cron task "${id}"\n`,
            stderr: '',
            exitCode: 0,
          };
        }

        default:
          return {
            stdout: '',
            stderr: `crontask: unknown command "${subcommand}"\n`,
            exitCode: 1,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: `crontask: ${msg}\n`,
        exitCode: 1,
      };
    }
  });
}
