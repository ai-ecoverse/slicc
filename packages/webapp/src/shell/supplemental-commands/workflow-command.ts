// packages/webapp/src/shell/supplemental-commands/workflow-command.ts
import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import type { CommandContextLike, WorkflowRunManager } from '../../scoops/workflow-run-manager.js';
import { WORKFLOW_MANAGER_GLOBAL_KEY } from '../../scoops/workflow-run-manager.js';
import { executeJsCode } from '../jsh-executor.js';
import { WORKFLOW_PRELUDE } from './workflow-prelude.js';
import {
  buildWorkflowCode,
  makeSentinel,
  parseMetaBanner,
  splitSentinel,
} from './workflow-script.js';

const log = createLogger('workflow-command');

const HELP = `usage: workflow run <file.js> [--args <json>] [--budget <n>] [--concurrency <n>] [--wait]
       workflow run --script '<inline js>' [...]
       workflow list
       workflow status <runId>
       workflow stop <runId>
       workflow save <runId> <name> [--force]
Runs a Claude-Code-format dynamic workflow. Default is non-blocking (returns a run id);
pass --wait to block and print the full result.`;

type ExecResult = { stdout: string; stderr: string; exitCode: number };

interface Parsed {
  help?: boolean;
  error?: string;
  file?: string;
  script?: string;
  args?: unknown;
  hasArgs?: boolean;
  budget?: number | null;
  cap?: number;
  wait?: boolean;
}

function getRunManager(): WorkflowRunManager | undefined {
  return (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY] as
    | WorkflowRunManager
    | undefined;
}

export function resolveMaxCap(): number {
  const cores =
    (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency ?? 8;
  // Scoops are I/O-bound (LLM/network), not CPU-bound — so scale generously with cores
  // (~4 scoops/core) and floor at 8 so small boxes (2-core cloud cones) still fan out;
  // ceiling 16 protects provider rate limits + browser memory. (Was min(16, cores-2),
  // which collapsed to 1 on 2-3 core machines.)
  return Math.min(16, Math.max(8, cores * 4));
}

// Apply one CLI token, mutating `o`; returns the (possibly advanced) index or a
// help/error signal. Split out of `parse` so each unit's branching stays shallow.
function applyToken(
  o: Parsed,
  a: string[],
  i: number,
  maxCap: number
): { i: number; help?: boolean; error?: string } {
  const t = a[i];
  switch (t) {
    case '-h':
    case '--help':
      return { i, help: true };
    case '--script':
      o.script = a[++i];
      return { i };
    case '--wait':
      o.wait = true;
      return { i };
    case '--args':
      try {
        o.args = JSON.parse(a[++i] ?? '');
        o.hasArgs = true;
      } catch {
        return { i, error: 'workflow: --args must be valid JSON' };
      }
      return { i };
    case '--budget': {
      const n = Number(a[++i]);
      if (!Number.isFinite(n)) return { i, error: 'workflow: --budget must be a number' };
      o.budget = n;
      return { i };
    }
    case '--concurrency': {
      const n = Number(a[++i]);
      if (!Number.isFinite(n)) return { i, error: 'workflow: --concurrency must be a number' };
      o.cap = Math.min(maxCap, Math.max(1, Math.trunc(n)));
      return { i };
    }
    default:
      if (t.startsWith('-')) return { i, error: `workflow: unknown flag '${t}'` };
      if (o.file !== undefined) return { i, error: 'workflow: too many arguments' };
      o.file = t;
      return { i };
  }
}

function parse(a: string[]): Parsed {
  if (a[0] !== 'run') {
    if (a.length === 0 || a.includes('-h') || a.includes('--help')) return { help: true };
    return { error: `workflow: unknown subcommand '${a[0]}' (only 'run' in SP1)` };
  }
  const maxCap = resolveMaxCap();
  const o: Parsed = { budget: null, cap: Math.min(8, maxCap) }; // default 8 (was 4), clamped to maxCap
  for (let i = 1; i < a.length; i++) {
    const r = applyToken(o, a, i, maxCap);
    if (r.help) return { help: true };
    if (r.error) return { error: r.error };
    i = r.i;
  }
  if (o.script === undefined && o.file === undefined)
    return { error: 'workflow: a <file.js> or --script is required' };
  return o;
}

export function createWorkflowCommand(
  options: {
    getParentJid?: () => string | undefined;
    syncScriptCommands?: () => void | Promise<void>;
  } = {}
): Command {
  return defineCommand('workflow', async (args, ctx) => {
    if (args[0] === 'list' || args[0] === 'status' || args[0] === 'stop')
      return runSubcommand(args, ctx);
    if (args[0] === 'save') return runSave(args, ctx, options);

    const p = parse(args);
    if (p.help) return { stdout: HELP + '\n', stderr: '', exitCode: 0 };
    if (p.error) return { stdout: '', stderr: p.error + '\n', exitCode: 1 };

    let source: string, filename: string;
    if (p.script !== undefined) {
      source = p.script;
      filename = '<workflow>';
    } else {
      const path = ctx.fs.resolvePath(ctx.cwd, p.file!);
      if (!(await ctx.fs.exists(path)))
        return { stdout: '', stderr: `workflow: file not found: ${p.file}\n`, exitCode: 1 };
      source = await ctx.fs.readFile(path);
      filename = p.file!;
    }

    const banner = parseMetaBanner(source);
    if (!banner.name)
      return {
        stdout: '',
        stderr: 'workflow: script must define a meta block with a name (description optional)\n',
        exitCode: 1,
      };
    // ONE id per run: a slice of a fresh random sentinel is a convenient
    // unguessable source (always non-empty). It keys the per-run scratch cwd here
    // AND is passed to `mgr.start({ runId })` (non-blocking path) so the scratch
    // tree, the result file (`/shared/workflow-runs/<id>.json`), `workflow status
    // <id>`, and the realm argv all share one id the user sees. (`--wait` bypasses
    // the manager, so the id is only the scratch-dir key there.)
    const runId = makeSentinel().slice('WF_RESULT_'.length, 'WF_RESULT_'.length + 12);
    const agentCwd = `/shared/workflow-runs/${runId}/scratch/`;
    await ctx.fs.mkdir(agentCwd, { recursive: true }); // agent rejects a missing cwd → would null every call
    const sentinel = makeSentinel();
    const code = buildWorkflowCode({
      prelude: WORKFLOW_PRELUDE,
      config: {
        ...(p.hasArgs ? { args: p.args } : {}),
        cap: p.cap ?? 8,
        budget: p.budget ?? null,
        cwd: ctx.cwd,
        agentCwd,
      }, // NOTE: sentinel passed separately (not in __WF — anti-spoof)
      body: source,
      sentinel,
    });

    if (p.wait) return runWait(code, filename, sentinel, banner, ctx);
    return startRun({ code, source, name: banner.name, filename, sentinel, runId, ctx, options });
  });
}

// `--wait` preserves SP1 foreground behavior EXACTLY: run the realm inline, print the
// FULL result, and do NOT register a run or fire a completion lick. (Routing --wait
// through the manager would only surface a preview and would fire an async 'workflow'
// lick for cone-origin runs — neither of which SP1 did.) The run manager is NOT required.
async function runWait(
  code: string,
  filename: string,
  sentinel: string,
  banner: { name: string | null; description: string | null },
  ctx: CommandContext
): Promise<ExecResult> {
  let result: ExecResult;
  try {
    result = await executeJsCode(code, ['workflow', filename], ctx, undefined, { filename });
  } catch (err) {
    log.error('workflow run failed', err);
    return {
      stdout: '',
      stderr: `workflow: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
  return renderResult(banner, result, sentinel); // SP1 helper — full result, no lick
}

// Non-blocking (default): delegate to the run manager and print the started line.
async function startRun(opts: {
  code: string;
  source: string;
  name: string;
  filename: string;
  sentinel: string;
  // The id the command minted for the scratch cwd; threaded so the manager keys the
  // registry / result file / `workflow status` off the SAME id (no orphaned scratch).
  runId: string;
  ctx: CommandContext;
  options: { getParentJid?: () => string | undefined };
}): Promise<ExecResult> {
  const mgr = getRunManager();
  if (!mgr) return { stdout: '', stderr: 'workflow: run manager not available\n', exitCode: 1 };
  const parentJid = opts.options.getParentJid?.();
  const { runId } = await mgr.start({
    code: opts.code,
    source: opts.source,
    name: opts.name,
    filename: opts.filename,
    parentJid,
    // The exec signature diverges (just-bash's CommandExecOptions vs our optional subset);
    // the manager never reads stdin (now typed as unknown), so cast is minimal.
    ctx: opts.ctx as CommandContextLike,
    sentinel: opts.sentinel,
    runId: opts.runId,
  });
  return {
    stdout: `▶ workflow '${opts.name}' started (run ${runId}). Watch: workflow status ${runId}\n`,
    stderr: '',
    exitCode: 0,
  };
}

const SAVE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAVED_WORKFLOWS_DIR = '/workspace/.workflows';

// `workflow save <runId> <name> [--force]` — persist a backgrounded run's source as a
// reusable bare command. Reject-at-save on name collision (built-in / existing command).
// --wait runs bypass the manager (no runId) → "no run". See spec §Save.
async function runSave(
  args: string[],
  ctx: CommandContext,
  options: { syncScriptCommands?: () => void | Promise<void> }
): Promise<ExecResult> {
  // Positional parse: `--force` is a flag (it may appear anywhere); the first two NON-flag
  // tokens are <runId> <name>. Reject extra positionals so a typo'd invocation fails loudly
  // instead of silently ignoring trailing args. (`SAVE_NAME` below also rejects a name that
  // looks like a flag, so a stray `--force` can never be mistaken for the name.)
  let force = false;
  const positionals: string[] = [];
  for (const a of args.slice(1)) {
    if (a === '--force') force = true;
    else positionals.push(a);
  }
  const [runId, name, ...extra] = positionals;
  if (!runId || !name || extra.length > 0)
    return { stdout: '', stderr: 'usage: workflow save <runId> <name> [--force]\n', exitCode: 1 };
  if (!SAVE_NAME.test(name))
    return {
      stdout: '',
      stderr: `workflow: invalid name '${name}' (use [a-z0-9][a-z0-9-]*)\n`,
      exitCode: 1,
    };

  const mgr = getRunManager();
  const run = mgr?.getRun(runId);
  if (!run)
    return {
      stdout: '',
      stderr: `workflow: no run '${runId}' (only backgrounded runs are saveable; --wait runs are not)\n`,
      exitCode: 1,
    };
  if (!run.source)
    return { stdout: '', stderr: `workflow: run '${runId}' has no source to save\n`, exitCode: 1 };

  const path = `${SAVED_WORKFLOWS_DIR}/${name}.workflow.js`;
  const targetExists = await ctx.fs.exists(path);
  if (targetExists) {
    // Overwriting an EXISTING saved workflow of the same name. `name` is in the registered-
    // command set, but only because THIS workflow registered it — so skip the collision check
    // and gate purely on --force. (Without this, re-saving over your own workflow would always
    // be rejected once Task 4 registers it.)
    if (!force)
      return {
        stdout: '',
        stderr: `workflow: ${path} already exists (pass --force to overwrite)\n`,
        exitCode: 1,
      };
  } else {
    // New name — reject-at-save if it collides with a built-in or any existing command, so
    // dispatch-time precedence can't later let a built-in/.jsh silently shadow this workflow.
    const existing = new Set(ctx.getRegisteredCommands?.() ?? []);
    if (existing.has(name))
      return {
        stdout: '',
        stderr: `workflow: '${name}' is already a command — choose another name\n`,
        exitCode: 1,
      };
  }

  await ctx.fs.mkdir(SAVED_WORKFLOWS_DIR, { recursive: true });
  await ctx.fs.writeFile(path, run.source);
  // The file is now persisted. A re-sync failure (e.g. a VFS walk throwing mid-scan) must
  // NOT surface as a raw rejection on an operation that already succeeded — downgrade to a
  // warning; the watcher re-syncs on the next tick, so the command still appears.
  try {
    await options.syncScriptCommands?.();
  } catch (err) {
    log.warn('workflow save: command re-sync failed; workflow saved, will register on next sync', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Don't over-promise the bare name: precedence is `built-in > .jsh > saved-workflow`,
  // so on a `--force` overwrite a `.jsh` that appeared since the original save could shadow
  // it. Always surface the canonical `workflow run <path>` escape hatch.
  return {
    stdout:
      `saved workflow '${name}' → ${path}\n` +
      `run it as '${name}' (or 'workflow run ${path}' if a built-in/.jsh shadows the name)\n`,
    stderr: '',
    exitCode: 0,
  };
}

// Read/stop subcommands. Resolves the manager from globalThis at call time (the cone and
// the panel terminal share the same published manager — no injection).
async function runSubcommand(args: string[], ctx: CommandContext): Promise<ExecResult> {
  const mgr = getRunManager();
  if (args[0] === 'list') {
    if (!mgr) return { stdout: '', stderr: 'workflow: run manager not available\n', exitCode: 1 };
    const rows = mgr
      .listRuns()
      .map(
        (r) => `${r.id}  ${r.status.padEnd(7)}  ${r.agentsDone}/${r.agentsStarted}  ${r.name ?? ''}`
      );
    return {
      stdout: (rows.length ? rows.join('\n') : '(no runs)') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }
  const id = args[1];
  const st = mgr?.getRun(id ?? '');
  if (!st) return { stdout: '', stderr: `workflow: no run '${id}'\n`, exitCode: 1 };
  if (args[0] === 'status') {
    const lines = [
      `run ${st.id}  (${st.name ?? 'unnamed'})  status=${st.status}`,
      `agents ${st.agentsDone}/${st.agentsStarted}  phase=${st.currentPhase ?? '-'}`,
      st.resultPath ? `result: ${st.resultPath}` : '',
      st.preview ? `preview: ${st.preview}` : '',
      st.error ? `error: ${st.error}` : '',
    ].filter(Boolean);
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }
  // stop
  if (st.pid == null) {
    return {
      stdout: `workflow: run ${st.id} has not started a realm process yet (nothing to stop)\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  // Terminal runs may have a stale pid the kernel ProcessManager has already recycled —
  // killing it would target an unrelated process. Skip the kill and report current status.
  if (st.status !== 'running' && st.status !== 'paused') {
    return { stdout: `workflow: run ${st.id} already ${st.status}\n`, stderr: '', exitCode: 0 };
  }
  const r = await ctx.exec?.('kill', { cwd: ctx.cwd, args: ['-KILL', String(st.pid)] });
  if (r && r.exitCode !== 0) {
    return {
      stdout: '',
      stderr: r.stderr || `workflow: kill failed (exit ${r.exitCode})\n`,
      exitCode: r.exitCode,
    };
  }
  return { stdout: `stopped run ${st.id} (pid ${st.pid})\n`, stderr: '', exitCode: 0 };
}

// Compose the command output from the realm result: banner + rendered progress
// log + the sentinel-extracted return value. Split out to keep the handler shallow.
function renderResult(
  banner: { name: string | null; description: string | null },
  result: { stdout: string; stderr: string; exitCode: number },
  sentinel: string
): { stdout: string; stderr: string; exitCode: number } {
  const { result: value, log: runLog, hadResult } = splitSentinel(result.stdout, sentinel);
  const head = banner.name
    ? `workflow: ${banner.name}${banner.description ? ' — ' + banner.description : ''}\n`
    : '';
  const logBlock = runLog ? renderLog(runLog) + '\n' : '';
  if (result.exitCode !== 0 || !hadResult)
    return {
      stdout: head + logBlock,
      stderr: result.stderr || (hadResult ? '' : 'workflow: script produced no result\n'),
      exitCode: result.exitCode || 1,
    };
  return {
    stdout: head + logBlock + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n',
    stderr: result.stderr,
    exitCode: 0,
  };
}

function renderLog(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/^WFPHASE/, '▸ ').replace(/^WFLOG/, '· '))
    .join('\n');
}
