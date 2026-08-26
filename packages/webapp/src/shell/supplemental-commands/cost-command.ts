import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { FrozenSessionIndexEntry } from '../../transcript/frozen-archive-format.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

/** Boolean flags accepted by `cost` (any position). */
const COST_BOOL_FLAGS = ['--all', '--json'] as const;

export type SessionCostScope = 'live' | 'all';

export interface ScoopCostData {
  name: string;
  type: 'cone' | 'scoop';
  model: string;
  /** All models used by this session, sorted by cost descending. */
  models: string[];
  /** Whether the session is live, was dropped, or was loaded from the frozen-session index. */
  source: 'live' | 'dropped' | 'frozen';
  /** False when a legacy frozen-session index entry has no persisted cost metadata. */
  costAvailable?: boolean;
  usage: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  turns: number;
  /** Timestamp (ms) of first assistant message */
  firstActivity?: number;
  /** Timestamp (ms) of last assistant message */
  lastActivity?: number;
  /** Total active time in milliseconds (rounded to 15-minute intervals) */
  activeTimeMs?: number;
}

type SessionCostsProvider = (scope: SessionCostScope) => ScoopCostData[] | Promise<ScoopCostData[]>;

let sessionCostsProvider: SessionCostsProvider | null = null;

export function registerSessionCostsProvider(fn: SessionCostsProvider): void {
  sessionCostsProvider = fn;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Map a frozen-session index entry into the shared cost-command row shape. */
export function frozenSessionToCostData(entry: FrozenSessionIndexEntry): ScoopCostData {
  const frozenModels = Array.isArray(entry.models) ? entry.models : [];
  const models = frozenModels
    .map((item) => (typeof item?.model === 'string' ? item.model : ''))
    .filter(Boolean);
  const costAvailable = Number.isFinite(entry.cost?.total);

  return {
    name: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : entry.filename,
    type: 'cone',
    model: models[0] ?? '-',
    models,
    source: 'frozen',
    costAvailable,
    usage: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      totalTokens: frozenModels.reduce((total, item) => total + finiteNumber(item?.tokens), 0),
      cost: {
        input: finiteNumber(entry.cost?.input),
        output: finiteNumber(entry.cost?.output),
        cacheRead: finiteNumber(entry.cost?.cacheRead),
        cacheWrite: finiteNumber(entry.cost?.cacheWrite),
        total: finiteNumber(entry.cost?.total),
      },
    },
    turns: frozenModels.reduce((total, item) => total + finiteNumber(item?.turns), 0),
  };
}

/** @internal Reset provider — exposed for tests only. */
export function _resetSessionCostsProvider(): void {
  sessionCostsProvider = null;
}

function helpText(): string {
  return `cost - show session cost breakdown

Usage: cost [options]

Options:
  --all        Include dropped scoops and frozen sessions
  --json       Output as JSON (for programmatic use)
  -h, --help   Show this help message
`;
}

function fmtMTok(tokens: number | null): string {
  if (tokens === null) return '-';
  const mtok = tokens / 1_000_000;
  if (mtok < 0.01) return '<0.01';
  return mtok.toFixed(2);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtHourlyRate(cost: number, activeTimeMs?: number): string {
  if (!activeTimeMs || activeTimeMs === 0) return '-';
  const hours = activeTimeMs / (1000 * 60 * 60);
  if (hours === 0) return '-';
  const hourlyRate = cost / hours;
  return `$${hourlyRate.toFixed(2)}`;
}

function truncModel(model: string, maxLen: number): string {
  if (model.length <= maxLen) return model;
  return model.slice(0, maxLen - 3) + '...';
}

function formatTable(data: ScoopCostData[]): string {
  const lines: string[] = [];
  lines.push('Session Cost Breakdown:\n');

  // Fixed column widths
  const COL_AGENT = 16;
  const COL_SOURCE = 10;
  const COL_MODEL = 18;
  const COL_MTOK = 15; // "  0.01 /   0.03"
  const COL_CACHE = 15;
  const COL_COST = 10;
  const COL_HOURLY = 10;

  const hdr =
    '  ' +
    'Agent'.padEnd(COL_AGENT) +
    'Source'.padEnd(COL_SOURCE) +
    'Model'.padEnd(COL_MODEL) +
    'MTok (in/out)'.padEnd(COL_MTOK) +
    'Cache (r/w)'.padEnd(COL_CACHE) +
    'Cost'.padStart(COL_COST) +
    '$/hour'.padStart(COL_HOURLY);

  const totalWidth =
    2 + COL_AGENT + COL_SOURCE + COL_MODEL + COL_MTOK + COL_CACHE + COL_COST + COL_HOURLY;
  const sep = '  ' + '─'.repeat(totalWidth - 2);

  lines.push(hdr);
  lines.push(sep);

  let totIn: number | null = 0,
    totOut: number | null = 0,
    totCR: number | null = 0,
    totCW: number | null = 0,
    totCost: number | null = 0;

  for (const d of data) {
    const agent = truncModel(d.name, COL_AGENT).padEnd(COL_AGENT);
    const source = d.source.padEnd(COL_SOURCE);
    const model = truncModel(d.model, COL_MODEL).padEnd(COL_MODEL);
    const tokens =
      `${fmtMTok(d.usage.input).padStart(5)} / ${fmtMTok(d.usage.output).padStart(5)}`.padEnd(
        COL_MTOK
      );
    const cache =
      `${fmtMTok(d.usage.cacheRead).padStart(5)} / ${fmtMTok(d.usage.cacheWrite).padStart(5)}`.padEnd(
        COL_CACHE
      );
    const cost = (d.costAvailable === false ? '-' : fmtCost(d.usage.cost.total)).padStart(COL_COST);
    const hourly =
      d.costAvailable === false
        ? '-'.padStart(COL_HOURLY)
        : fmtHourlyRate(d.usage.cost.total, d.activeTimeMs).padStart(COL_HOURLY);

    lines.push(`  ${agent}${source}${model}${tokens}${cache}${cost}${hourly}`);

    totIn = totIn === null || d.usage.input === null ? null : totIn + d.usage.input;
    totOut = totOut === null || d.usage.output === null ? null : totOut + d.usage.output;
    totCR = totCR === null || d.usage.cacheRead === null ? null : totCR + d.usage.cacheRead;
    totCW = totCW === null || d.usage.cacheWrite === null ? null : totCW + d.usage.cacheWrite;
    totCost = totCost === null || d.costAvailable === false ? null : totCost + d.usage.cost.total;
  }

  lines.push(sep);

  const totalAgent = 'Total'.padEnd(COL_AGENT);
  const totalSource = ''.padEnd(COL_SOURCE);
  const totalModel = ''.padEnd(COL_MODEL);
  const totalTokens = `${fmtMTok(totIn).padStart(5)} / ${fmtMTok(totOut).padStart(5)}`.padEnd(
    COL_MTOK
  );
  const totalCache = `${fmtMTok(totCR).padStart(5)} / ${fmtMTok(totCW).padStart(5)}`.padEnd(
    COL_CACHE
  );
  const totalCost = (totCost === null ? '-' : fmtCost(totCost)).padStart(COL_COST);
  const totalHourly = ''.padStart(COL_HOURLY);

  lines.push(
    `  ${totalAgent}${totalSource}${totalModel}${totalTokens}${totalCache}${totalCost}${totalHourly}`
  );

  return lines.join('\n') + '\n';
}

export function createCostCommand(): Command {
  return defineCommand('cost', async (args) => {
    if (isHelpRequest(args)) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    const parsed = parseKnownFlags(args, { bool: COST_BOOL_FLAGS });
    if ('error' in parsed) {
      return { stdout: '', stderr: `cost: ${parsed.error}\n`, exitCode: 1 };
    }

    if (!sessionCostsProvider) {
      return { stdout: '', stderr: 'Cost data not available.\n', exitCode: 1 };
    }

    const scope: SessionCostScope = parsed.bools.has('--all') ? 'all' : 'live';
    const data = await sessionCostsProvider(scope);

    if (data.length === 0) {
      return { stdout: 'No session cost data yet.\n', stderr: '', exitCode: 0 };
    }

    if (parsed.bools.has('--json')) {
      return { stdout: JSON.stringify(data, null, 2) + '\n', stderr: '', exitCode: 0 };
    }

    return { stdout: formatTable(data), stderr: '', exitCode: 0 };
  });
}
