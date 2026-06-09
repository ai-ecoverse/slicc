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
  options: { getParentJid?: () => string | undefined } = {}
): Command {
  return defineCommand('workflow', async (args, ctx) => {
    if (args[0] === 'list' || args[0] === 'status' || args[0] === 'stop')
      return runSubcommand(args, ctx);

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
    // runId is just the per-run scratch-dir key; a slice of a fresh random
    // sentinel is a convenient unguessable source (always non-empty).
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
    return startRun({ code, source, name: banner.name, filename, sentinel, ctx, options });
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
  });
  return {
    stdout: `▶ workflow '${opts.name}' started (run ${runId}). Watch: workflow status ${runId}\n`,
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
  if (st.pid != null) await ctx.exec?.('kill', { cwd: ctx.cwd, args: ['-KILL', String(st.pid)] });
  return { stdout: `stopped run ${st.id} (pid ${st.pid ?? '?'})\n`, stderr: '', exitCode: 0 };
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
