/**
 * `sprinkle` shell command — manage SHTML sprinkle panels.
 *
 * Usage:
 *   sprinkle list                  — list available .shtml sprinkles + instances
 *   sprinkle open <name>           — open a sprinkle
 *   sprinkle close <name>          — close a sprinkle
 *   sprinkle refresh               — re-scan VFS for .shtml files
 *   sprinkle send <name> <json>    — push data to a sprinkle (agent -> sprinkle)
 *   sprinkle chat <html>           — show inline HTML in chat (Tool UI)
 *   echo "<html>" | sprinkle chat  — show piped HTML in chat
 *
 * Flags are rejected when unrecognised (issue #2166): a command that
 * swallows `--runtime=TOTALLY-FAKE` and exits 0 is indistinguishable from
 * one that honoured it, which is worse than not supporting the flag at all.
 */

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

/**
 * The manager is published on `globalThis` (as `window` in the page realm, as
 * the worker global for the kernel proxy) so the same lookup works in both.
 */
interface SprinkleGlobals {
  __slicc_sprinkleManager?: SprinkleManagerHandle;
}

function getSprinkleManager(): SprinkleManagerHandle | null {
  return (globalThis as SprinkleGlobals).__slicc_sprinkleManager ?? null;
}

// ── Flag parsing ────────────────────────────────────────────────────────────

interface ParsedFlags {
  positionals: string[];
  values: Map<string, string>;
  bools: Set<string>;
}

/**
 * Walk every token: known value flags consume `--flag=value` or
 * `--flag value`, known boolean flags stand alone, and any other
 * dash-prefixed token is an error. Unlike the leading-flag walks elsewhere
 * in this directory, flags are accepted in any position — the repro in
 * issue #2166 put `--runtime` both before and after the JSON payload.
 *
 * Everything after a `--` terminator is positional, so a payload that
 * genuinely starts with a dash stays reachable.
 */
function parseFlags(
  args: readonly string[],
  spec: { value?: readonly string[]; bool?: readonly string[] }
): ParsedFlags | { error: string } {
  const valueFlags = new Set(spec.value ?? []);
  const boolFlags = new Set(spec.bool ?? []);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (valueFlags.has(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined) return { error: `${name} requires a value` };
      values.set(name, value);
      continue;
    }
    if (boolFlags.has(name)) {
      bools.add(name);
      continue;
    }
    return { error: `unknown flag: ${name}` };
  }
  return { positionals, values, bools };
}

/** `sprinkle <sub>: <message>` on stderr, exit 1. */
function fail(sub: string, message: string): Result {
  return { stdout: '', stderr: `sprinkle ${sub}: ${message}\n`, exitCode: 1 };
}

// ── Runtime targeting ───────────────────────────────────────────────────────

/**
 * Runtime ids a push or listing can name: the leader plus every connected
 * follower. Validated up front so a fabricated id fails loudly instead of
 * silently behaving like a broadcast (issue #2166).
 */
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

// ── Subcommands ─────────────────────────────────────────────────────────────

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

/** One `instance:` line per rendering runtime, indented under its sprinkle. */
function instanceLines(instances: SprinkleInstance[]): string[] {
  return instances.map((i) => {
    const tag = i.runtime ? ` (${i.runtime})` : '';
    return `      instance: ${i.runtimeId}${tag}`;
  });
}

/**
 * Instances of every sprinkle: the leader's own open set plus whatever the
 * connected followers reported rendering. Reported, not inferred — a
 * follower that failed to render is absent rather than silently counted.
 */
function collectInstances(opened: readonly string[]): SprinkleInstance[] {
  const leaderInstances: SprinkleInstance[] = opened.map((name) => ({
    name,
    runtimeId: LEADER_RUNTIME_ID,
  }));
  return [...leaderInstances, ...getFollowerSprinkleInstances()];
}

async function handleList(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const parsed = parseFlags(args.slice(1), { value: ['--runtime'] });
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
    // With `--runtime`, only sprinkles that runtime actually renders are
    // interesting — an unfiltered listing would repeat the same answer for
    // every runtime id, which is exactly the false confidence #2166 reports.
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

/**
 * Claim an unrouted sprinkle for the cone whose shell is opening it.
 *
 * A panel's `slicc.lick()` events follow the sprinkle's route, and the route
 * table is global (one entry per sprinkle name, not per shell) — so without a
 * claim an extra cone's panel posts into the oldest cone's chat (#2311). This
 * is the same "creator names itself" rule `fswatch` applies to an untargeted
 * watcher. An existing route always wins; `sprinkle route <name> --clear`
 * gives the sprinkle back.
 *
 * The claim has to be installed BEFORE `mgr.open()`: `open()` renders and
 * activates the SHTML bridge before its promise resolves, so a startup script
 * calling `slicc.lick()` reads the route table while we are still awaiting.
 * Returns the claimed target when it was both new AND actually stored —
 * `sprinkle-routes.ts` is localStorage-backed and swallows a missing or full
 * store, and announcing a route that silently did not stick would be a lie.
 */
function claimSprinkleRoute(name: string, env: LickTargetEnv): string | null {
  const claimed = defaultLickTarget(undefined, env);
  if (!claimed || getSprinkleRoute(name)) return null;
  setSprinkleRoute(name, claimed);
  return getSprinkleRoute(name) === claimed ? claimed : null;
}

async function handleOpen(
  mgr: SprinkleManagerHandle,
  args: string[],
  env: LickTargetEnv
): Promise<Result> {
  const parsed = parseFlags(args.slice(1), {});
  if ('error' in parsed) return fail('open', parsed.error);
  const name = parsed.positionals[0];
  if (!name) return fail('open', 'name required');
  const claimed = claimSprinkleRoute(name, env);
  try {
    await mgr.open(name);
  } catch (err) {
    // Roll the claim back — a sprinkle that never opened must not leave a
    // route behind that would silently capture a later `open` by another cone.
    if (claimed) clearSprinkleRoute(name);
    return fail('open', err instanceof Error ? err.message : String(err));
  }
  const routed = claimed ? `; licks route to "${claimed}"` : '';
  return { stdout: `Sprinkle "${name}" opened${routed}.\n`, stderr: '', exitCode: 0 };
}

function handleClose(mgr: SprinkleManagerHandle, args: string[]): Result {
  const parsed = parseFlags(args.slice(1), {});
  if ('error' in parsed) return fail('close', parsed.error);
  const name = parsed.positionals[0];
  if (!name) return fail('close', 'name required');
  mgr.close(name);
  return { stdout: `Sprinkle "${name}" closed.\n`, stderr: '', exitCode: 0 };
}

async function handleReload(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const parsed = parseFlags(args.slice(1), {});
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
  const parsed = parseFlags(args.slice(1), {});
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
  const parsed = parseFlags(args.slice(1), { value: ['--scoop'], bool: ['--clear'] });
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

/** `leader, follower-8a47… (slicc-standalone)` for the delivery line. */
function describeReach(report: SprinkleSendReport): string {
  const parts: string[] = [];
  if (report.leader) parts.push(LEADER_RUNTIME_ID);
  parts.push(...report.followers);
  return parts.join(', ');
}

async function handleSend(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const parsed = parseFlags(args.slice(1), { value: ['--runtime'] });
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
    // Every in-repo manager returns a report. A missing one means the shell
    // is talking to a stale manager surface, and claiming success would be
    // the same false confidence this command exists to remove.
    return fail('send', 'sprinkle manager returned no delivery report — push not confirmed');
  }
  if (report.unknownRuntime) {
    return fail('send', unknownRuntimeMessage(report.unknownRuntime));
  }
  const reach = sendReportReach(report);
  if (reach === 0) {
    // The old code printed "Data sent" here and exited 0 even though the
    // manager had logged "Cannot send to closed sprinkle" and dropped it.
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
    // Help before the handler: `chat --help` used to render the flag as
    // Tool-UI HTML. `sprinkle chat -- --help` still renders it literally.
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
