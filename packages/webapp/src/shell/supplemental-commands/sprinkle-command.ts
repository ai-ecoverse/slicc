import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { stdinAsText } from '../just-bash-compat.js';
import { defaultLickTarget, type LickTargetEnv } from '../lick-target-env.js';
import { getFollowerSprinkleInstances, LEADER_RUNTIME_ID } from '../sprinkle-instances.js';
import type {
  SprinkleInstance,
  SprinkleManagerHandle,
  SprinkleSendReport,
} from '../sprinkle-manager-handle.js';
import { sendReportReach } from '../sprinkle-manager-handle.js';
import {
  clearSprinkleRoute,
  getAllSprinkleRoutes,
  getSprinkleRoute,
  setSprinkleRoute,
} from '../sprinkle-routes.js';
import { showToolUIFromContext } from '../tool-ui.js';
import { getConnectedFollowersWithFallback } from './host-command.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest, stripOptionTerminator, subcommandHelpText } from './subcommand-help.js';

type Result = { stdout: string; stderr: string; exitCode: number };

function sprinkleHelp(): Result {
  return {
    stdout:
      'usage: sprinkle <subcommand> [args]\n\n' +
      '  list [--runtime <id>] List sprinkles + an instance line per runtime\n' +
      '  open <name>           Open a sprinkle by name\n' +
      '  close <name>          Close an open sprinkle\n' +
      '  reload <name>         Reload an open sprinkle (re-read .shtml)\n' +
      '  refresh               Re-scan VFS for .shtml files\n' +
      '  send <name> <json> [--runtime <id>]\n' +
      '                        Push data. Broadcasts to every open instance\n' +
      '                        (leader + followers) unless --runtime names one\n' +
      '                        (ids from `host`). Reports instances reached;\n' +
      '                        exits non-zero when it reached none.\n' +
      '  route <name> --scoop <target> Route licks to a scoop, cone, or folder\n' +
      '  route <name> --clear          Clear routing (revert to cone)\n' +
      '  route                         List all sprinkle routes\n' +
      '  chat <html>           Show inline HTML in chat (Tool UI)\n' +
      '                        Use data-action="name" on buttons for callbacks\n' +
      '                        Pipe HTML: echo "<div>...</div>" | sprinkle chat\n',
    stderr: '',
    exitCode: 0,
  };
}

interface SprinkleGlobals {
  __slicc_sprinkleManager?: SprinkleManagerHandle;
}

function getSprinkleManager(): SprinkleManagerHandle | null {
  return (globalThis as SprinkleGlobals).__slicc_sprinkleManager ?? null;
}

function fail(sub: string, message: string): Result {
  return { stdout: '', stderr: `sprinkle ${sub}: ${message}\n`, exitCode: 1 };
}

function knownRuntimeIds(): string[] {
  return [LEADER_RUNTIME_ID, ...getConnectedFollowersWithFallback().map((f) => f.runtimeId)];
}

function unknownRuntimeMessage(runtime: string): string {
  const known = knownRuntimeIds();
  return (
    `unknown runtime "${runtime}"\n` +
    `known runtimes: ${known.join(', ')}\n` +
    'Run `host` to see connected followers.'
  );
}

async function handleChat(args: string[], ctx: CommandContext): Promise<Result> {
  let html = args.slice(1).join(' ');
  if (!html) {
    const stdinText = stdinAsText(ctx.stdin);
    if (stdinText) html = stdinText;
  }
  if (!html) {
    return { stdout: '', stderr: 'sprinkle chat: HTML content required\n', exitCode: 1 };
  }
  const result = await showToolUIFromContext({
    html,
    onAction: async (action, data) => ({ action, data }),
  });
  if (result === null) {
    return { stdout: '', stderr: 'sprinkle chat: not in tool execution context\n', exitCode: 1 };
  }
  return { stdout: JSON.stringify(result) + '\n', stderr: '', exitCode: 0 };
}

function instanceLines(instances: SprinkleInstance[]): string[] {
  return instances.map((i) => {
    const tag = i.runtime ? ` (${i.runtime})` : '';
    return `      instance: ${i.runtimeId}${tag}`;
  });
}

function collectInstances(opened: readonly string[]): SprinkleInstance[] {
  const leaderInstances: SprinkleInstance[] = opened.map((name) => ({
    name,
    runtimeId: LEADER_RUNTIME_ID,
  }));
  return [...leaderInstances, ...getFollowerSprinkleInstances()];
}

async function handleList(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const parsed = parseKnownFlags(args.slice(1), { value: ['--runtime'] });
  if ('error' in parsed) return fail('list', parsed.error);
  const runtime = parsed.values.get('--runtime');
  if (runtime !== undefined && !knownRuntimeIds().includes(runtime)) {
    return fail('list', unknownRuntimeMessage(runtime));
  }

  await mgr.refresh();
  const sprinkles = mgr.available();
  if (sprinkles.length === 0) {
    return { stdout: 'No .shtml sprinkles found.\n', stderr: '', exitCode: 0 };
  }
  const opened = new Set(mgr.opened());
  const allInstances = collectInstances([...opened]).filter(
    (i) => runtime === undefined || i.runtimeId === runtime
  );

  const lines: string[] = [];
  for (const p of sprinkles) {
    const instances = allInstances.filter((i) => i.name === p.name);

    if (runtime !== undefined && instances.length === 0) continue;
    const status = opened.has(p.name) ? ' [open]' : '';
    lines.push(`  ${p.name}${status}  ${p.title}  (${p.path})`);
    lines.push(...instanceLines(instances));
  }
  if (lines.length === 0) {
    return {
      stdout: `No sprinkles are open on runtime "${runtime}".\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

function claimSprinkleRoute(name: string, claimed: string | undefined): string | null {
  if (!claimed || getSprinkleRoute(name)) return null;
  setSprinkleRoute(name, claimed);
  return getSprinkleRoute(name) === claimed ? claimed : null;
}

async function handleOpen(
  mgr: SprinkleManagerHandle,
  args: string[],
  env: LickTargetEnv
): Promise<Result> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return fail('open', parsed.error);
  const name = parsed.positionals[0];
  if (!name) return fail('open', 'name required');
  const openingTarget = defaultLickTarget(undefined, env);
  const claimed = claimSprinkleRoute(name, openingTarget);
  try {
    if (openingTarget) {
      await mgr.open(name, undefined, { lickOriginTarget: openingTarget });
    } else {
      await mgr.open(name);
    }
  } catch (err) {
    if (claimed) clearSprinkleRoute(name);
    return fail('open', err instanceof Error ? err.message : String(err));
  }
  const routed = claimed ? `; licks route to "${claimed}"` : '';
  return { stdout: `Sprinkle "${name}" opened${routed}.\n`, stderr: '', exitCode: 0 };
}

function handleClose(mgr: SprinkleManagerHandle, args: string[]): Result {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return fail('close', parsed.error);
  const name = parsed.positionals[0];
  if (!name) return fail('close', 'name required');
  mgr.close(name);
  return { stdout: `Sprinkle "${name}" closed.\n`, stderr: '', exitCode: 0 };
}

async function handleReload(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return fail('reload', parsed.error);
  const name = parsed.positionals[0];
  if (!name) return fail('reload', 'name required');
  try {
    await mgr.reload(name);
    return { stdout: `Sprinkle "${name}" reloaded.\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return fail('reload', err instanceof Error ? err.message : String(err));
  }
}

async function handleRefresh(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return fail('refresh', parsed.error);
  await mgr.refresh();
  const count = mgr.available().length;
  return {
    stdout: `Found ${count} sprinkle${count !== 1 ? 's' : ''}.\n`,
    stderr: '',
    exitCode: 0,
  };
}

function handleRoute(args: string[]): Result {
  const parsed = parseKnownFlags(args.slice(1), { value: ['--scoop'], bool: ['--clear'] });
  if ('error' in parsed) return fail('route', parsed.error);
  const name = parsed.positionals[0];
  if (!name) {
    const routes = getAllSprinkleRoutes();
    const entries = Object.entries(routes);
    if (entries.length === 0) {
      return {
        stdout: 'No sprinkle routes configured (all licks go to cone).\n',
        stderr: '',
        exitCode: 0,
      };
    }
    const lines = entries.map(([s, scoop]) => `  ${s} -> ${scoop}`);
    return {
      stdout:
        'Sprinkle routes (applied to every runtime — the leader resolves the\n' +
        'route for follower-forwarded licks too):\n' +
        lines.join('\n') +
        '\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (parsed.bools.has('--clear')) {
    clearSprinkleRoute(name);
    return {
      stdout: `Route cleared for sprinkle "${name}" (licks will go to cone).\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  const scoop = parsed.values.get('--scoop');
  if (!scoop) {
    const current = getSprinkleRoute(name);
    if (current) return { stdout: `${name} -> ${current}\n`, stderr: '', exitCode: 0 };
    return { stdout: `${name} -> cone (default)\n`, stderr: '', exitCode: 0 };
  }
  setSprinkleRoute(name, scoop);
  return {
    stdout: `Sprinkle "${name}" lick events will route to scoop "${scoop}".\n`,
    stderr: '',
    exitCode: 0,
  };
}

function describeReach(report: SprinkleSendReport): string {
  const parts: string[] = [];
  if (report.leader) parts.push(LEADER_RUNTIME_ID);
  parts.push(...report.followers);
  return parts.join(', ');
}

async function handleSend(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const parsed = parseKnownFlags(args.slice(1), { value: ['--runtime'] });
  if ('error' in parsed) return fail('send', parsed.error);
  const name = parsed.positionals[0];
  if (!name) return fail('send', 'name required');
  const jsonStr = parsed.positionals.slice(1).join(' ');
  if (!jsonStr) return fail('send', 'JSON data required');
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return fail('send', 'invalid JSON');
  }
  const runtime = parsed.values.get('--runtime');
  if (runtime !== undefined && !knownRuntimeIds().includes(runtime)) {
    return fail('send', unknownRuntimeMessage(runtime));
  }

  const report: SprinkleSendReport | undefined = await mgr.sendToSprinkle(
    name,
    data,
    runtime ? { runtime } : undefined
  );
  if (!report) {
    return fail('send', 'sprinkle manager returned no delivery report — push not confirmed');
  }
  if (report.unknownRuntime) {
    return fail('send', unknownRuntimeMessage(report.unknownRuntime));
  }
  const reach = sendReportReach(report);
  if (reach === 0) {
    return fail(
      'send',
      runtime
        ? `"${name}" is not open on runtime "${runtime}" — nothing was delivered`
        : `"${name}" is not open on the leader or any connected follower — nothing was delivered`
    );
  }
  return {
    stdout: `Data sent to sprinkle "${name}" — ${reach} instance${
      reach === 1 ? '' : 's'
    } (${describeReach(report)}).\n`,
    stderr: '',
    exitCode: 0,
  };
}

export function createSprinkleCommand(): Command {
  return defineCommand('sprinkle', async (args, ctx) => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return sprinkleHelp();
    }
    const sub = args[0];

    if (isHelpRequest(args.slice(1), { valueFlags: ['--scoop', '--runtime'] })) {
      return {
        stdout: subcommandHelpText('sprinkle', sub, sprinkleHelp().stdout),
        stderr: '',
        exitCode: 0,
      };
    }
    if (sub === 'chat') return handleChat(stripOptionTerminator(args), ctx);

    const mgr = getSprinkleManager();
    if (!mgr) {
      return { stdout: '', stderr: 'sprinkle: sprinkle manager not initialized\n', exitCode: 1 };
    }

    switch (sub) {
      case 'list':
        return handleList(mgr, args);
      case 'open':
        return handleOpen(mgr, args, ctx.env);
      case 'close':
        return handleClose(mgr, args);
      case 'reload':
        return handleReload(mgr, args);
      case 'refresh':
        return handleRefresh(mgr, args);
      case 'route':
        return handleRoute(args);
      case 'send':
        return handleSend(mgr, args);
      default:
        return { stdout: '', stderr: `sprinkle: unknown subcommand "${sub}"\n`, exitCode: 1 };
    }
  });
}
