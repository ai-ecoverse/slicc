import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { hasLocalNodeServer } from '../float-topology.js';
import { defaultLickTarget, type LickTargetEnv } from '../lick-target-env.js';
import { apiHeaders, resolveApiUrl } from '../proxied-fetch.js';
import { getLickManagerSurface } from './lick-surface.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

type CommandResult = { stdout: string; stderr: string; exitCode: number };

/** Standalone before `createKernelHost` published the manager — see `lick-surface.ts`. */
function notInitializedError(subcommand: string): CommandResult {
  return {
    stdout: '',
    stderr: `crontask ${subcommand}: kernel host has not booted yet — try again in a moment\n`,
    exitCode: 1,
  };
}

function crontaskHelp(): CommandResult {
  return {
    stdout: `usage: crontask <command> [options]

Commands:
  create [options]   Create a new cron task
  list               List all active cron tasks
  delete <id>        Delete a cron task by ID
  kill <id>          Alias for delete

Options:
  --name <name>     Name for the cron task (required)
  --scoop <target>  Scoop name, cone name, or folder. Omit for your own cone.
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
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const init: RequestInit = {
    method,
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
  };
  if (body) {
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(resolveApiUrl(`/api/crontasks${path}`), init);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

/** `create`'s flags all take a value — same names for `isHelpRequest`. */
const CREATE_VALUE_FLAGS = ['--name', '--cron', '--filter', '--scoop'] as const;

function flagError(message: string): CommandResult {
  return { stdout: '', stderr: `crontask: ${message}\n`, exitCode: 1 };
}

async function handleCreate(args: string[], env: LickTargetEnv): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), { value: CREATE_VALUE_FLAGS });
  if ('error' in parsed) return flagError(parsed.error);

  const name = parsed.values.get('--name');
  const cron = parsed.values.get('--cron');
  const filter = parsed.values.get('--filter');
  let scoop = parsed.values.get('--scoop');
  // No `--scoop`: a non-primary cone's shell names itself (SLICC_LICK_TARGET),
  // exactly as `fswatch` does, so its ticks come back to its own chat (#2311).
  scoop = defaultLickTarget(scoop, env);

  if (!name) {
    return { stdout: '', stderr: 'crontask: --name is required\n', exitCode: 1 };
  }

  if (!cron) {
    return { stdout: '', stderr: 'crontask: --cron is required\n', exitCode: 1 };
  }

  // No local node-server (extension-delegate/direct): use the worker LickManager (or proxy fallback).
  if (!hasLocalNodeServer()) {
    // Warn about filter limitation in extension mode (CSP blocks dynamic eval)
    if (filter) {
      return {
        stdout: '',
        stderr: 'crontask: --filter is not supported in extension mode (CSP restriction)\n',
        exitCode: 1,
      };
    }
    const lm = await getLickManagerSurface();
    if (!lm) return notInitializedError('create');
    const entry = await lm.createCronTask(name, cron, scoop);
    let output = `Created cron task "${entry.name}"\n`;
    output += `ID:       ${entry.id}\n`;
    output += `Cron:     ${entry.cron}\n`;
    if (entry.scoop) output += `Scoop:    ${entry.scoop}\n`;
    if (entry.nextRun) output += `Next run: ${new Date(entry.nextRun).toLocaleString()}\n`;
    return { stdout: output, stderr: '', exitCode: 0 };
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
  return { stdout: output, stderr: '', exitCode: 0 };
}

function formatTaskList(tasks: CronTaskInfo[]): string {
  let output = 'Active cron tasks:\n';
  for (const task of tasks) {
    output += `  ${task.id}  ${task.name.padEnd(20)}  ${task.cron.padEnd(15)}`;
    if (task.scoop) output += `  -> ${task.scoop}`;
    if (task.filter) output += `  [filtered]`;
    output += `  (${task.status})`;
    if (task.nextRun) output += `  next: ${new Date(task.nextRun).toLocaleString()}`;
    output += '\n';
  }
  return output;
}

async function handleList(args: string[]): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return flagError(parsed.error);

  if (!hasLocalNodeServer()) {
    const lm = await getLickManagerSurface();
    if (!lm) return notInitializedError('list');
    const tasks = await lm.listCronTasks();
    if (tasks.length === 0) {
      return { stdout: 'No active cron tasks\n', stderr: '', exitCode: 0 };
    }
    return { stdout: formatTaskList(tasks as CronTaskInfo[]), stderr: '', exitCode: 0 };
  }

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
    return { stdout: 'No active cron tasks\n', stderr: '', exitCode: 0 };
  }
  return { stdout: formatTaskList(tasks), stderr: '', exitCode: 0 };
}

async function handleDelete(args: string[]): Promise<CommandResult> {
  const subcommand = args[0];
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return flagError(parsed.error);

  const id = parsed.positionals[0];
  if (!id) {
    return { stdout: '', stderr: `crontask: ${subcommand} requires an ID\n`, exitCode: 1 };
  }

  // No local node-server (extension-delegate/direct): use the worker LickManager (or proxy fallback).
  if (!hasLocalNodeServer()) {
    const lm = await getLickManagerSurface();
    if (!lm) return notInitializedError('delete');
    const deleted = await lm.deleteCronTask(id);
    if (!deleted) {
      return { stdout: '', stderr: `crontask: task "${id}" not found\n`, exitCode: 1 };
    }
    return { stdout: `Deleted cron task "${id}"\n`, stderr: '', exitCode: 0 };
  }

  const { ok, status, data } = await apiCall('DELETE', `/${id}`);
  if (!ok) {
    if (status === 404) {
      return { stdout: '', stderr: `crontask: task "${id}" not found\n`, exitCode: 1 };
    }
    return {
      stdout: '',
      stderr: `crontask: failed to delete: ${(data as { error?: string }).error ?? 'unknown error'}\n`,
      exitCode: 1,
    };
  }

  return { stdout: `Deleted cron task "${id}"\n`, stderr: '', exitCode: 0 };
}

export function createCrontaskCommand(): Command {
  return defineCommand('crontask', async (args, ctx) => {
    const subcommand = args[0];
    if (!subcommand || isHelpRequest(args, { valueFlags: CREATE_VALUE_FLAGS })) {
      return crontaskHelp();
    }

    try {
      switch (subcommand) {
        case 'create':
          return await handleCreate(args, ctx.env);
        case 'list':
          return await handleList(args);
        case 'delete':
        case 'kill':
          return await handleDelete(args);
        default:
          return { stdout: '', stderr: `crontask: unknown command "${subcommand}"\n`, exitCode: 1 };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `crontask: ${msg}\n`, exitCode: 1 };
    }
  });
}
