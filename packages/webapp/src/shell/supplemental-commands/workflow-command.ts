// packages/webapp/src/shell/supplemental-commands/workflow-command.ts
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import { executeJsCode } from '../jsh-executor.js';
import { WORKFLOW_PRELUDE } from './workflow-prelude.js';
import {
  buildWorkflowCode,
  makeSentinel,
  parseMetaBanner,
  splitSentinel,
} from './workflow-script.js';

const log = createLogger('workflow-command');

const HELP = `usage: workflow run <file.js> [--args <json>] [--budget <n>] [--concurrency <n>]
       workflow run --script '<inline js>' [...]
Runs a Claude-Code-format dynamic workflow to completion (SP1: blocking, non-nesting).`;

interface Parsed {
  help?: boolean;
  error?: string;
  file?: string;
  script?: string;
  args?: unknown;
  hasArgs?: boolean;
  budget?: number | null;
  cap?: number;
}

function resolveMaxCap(): number {
  const cores =
    (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency ?? 8;
  return Math.min(16, Math.max(1, cores - 2)); // spec cap: min(16, cores-2)
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
  const o: Parsed = { budget: null, cap: Math.min(4, maxCap) }; // default 4, clamped to maxCap
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

export function createWorkflowCommand(): Command {
  return defineCommand('workflow', async (args, ctx) => {
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
        stderr: 'workflow: script must export a meta block with a name (and description)\n',
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
        cap: p.cap ?? 4,
        budget: p.budget ?? null,
        cwd: ctx.cwd,
        agentCwd,
      }, // NOTE: sentinel passed separately (not in __WF — anti-spoof)
      body: source,
      sentinel,
    });

    let result: { stdout: string; stderr: string; exitCode: number };
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

    return renderResult(banner, result, sentinel);
  });
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
