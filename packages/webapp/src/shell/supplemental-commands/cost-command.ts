import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

export interface ScoopCostData {
  name: string;
  type: 'cone' | 'scoop';
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
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

let sessionCostsProvider: (() => ScoopCostData[] | Promise<ScoopCostData[]>) | null = null;

export function registerSessionCostsProvider(
  fn: () => ScoopCostData[] | Promise<ScoopCostData[]>
): void {
  sessionCostsProvider = fn;
}

/** @internal Reset provider — exposed for tests only. */
export function _resetSessionCostsProvider(): void {
  sessionCostsProvider = null;
}

function helpText(): string {
  return `cost - show session cost breakdown

Usage: cost [options]

Options:
  --json       Output as JSON (for programmatic use)
  -h, --help   Show this help message
`;
}

function fmtMTok(tokens: number): string {
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

  const hdr =
    '  Agent              Model              MTok (in/out)  Cache (r/w)    Cost      $/hour';
  const sep =
    '  ──────────────────────────────────────────────────────────────────────────────────────';

  lines.push(hdr);
  lines.push(sep);

  let totIn = 0,
    totOut = 0,
    totCR = 0,
    totCW = 0,
    totCost = 0;

  for (const d of data) {
    const agent = d.name.padEnd(19);
    const model = truncModel(d.model, 18).padEnd(18);
    const tokens = `${fmtMTok(d.usage.input).padStart(6)} / ${fmtMTok(d.usage.output).padStart(6)}`;
    const tokenCol = tokens.padEnd(15);
    const cache = `${fmtMTok(d.usage.cacheRead).padStart(6)} / ${fmtMTok(d.usage.cacheWrite).padStart(6)}`;
    const cacheCol = cache.padEnd(15);
    const cost = fmtCost(d.usage.cost.total).padStart(9);
    const hourly = fmtHourlyRate(d.usage.cost.total, d.activeTimeMs).padStart(10);

    lines.push(`  ${agent} ${model} ${tokenCol} ${cacheCol} ${cost} ${hourly}`);

    totIn += d.usage.input;
    totOut += d.usage.output;
    totCR += d.usage.cacheRead;
    totCW += d.usage.cacheWrite;
    totCost += d.usage.cost.total;
  }

  lines.push(sep);

  const totalAgent = 'Total'.padEnd(19);
  const totalModel = ''.padEnd(18);
  const totalTokens = `${fmtMTok(totIn).padStart(6)} / ${fmtMTok(totOut).padStart(6)}`.padEnd(15);
  const totalCache = `${fmtMTok(totCR).padStart(6)} / ${fmtMTok(totCW).padStart(6)}`.padEnd(15);
  const totalCost = fmtCost(totCost).padStart(9);
  const totalHourly = ''.padStart(10);

  lines.push(
    `  ${totalAgent} ${totalModel} ${totalTokens} ${totalCache} ${totalCost} ${totalHourly}`
  );

  return lines.join('\n') + '\n';
}

export function createCostCommand(): Command {
  return defineCommand('cost', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    if (!sessionCostsProvider) {
      return { stdout: '', stderr: 'Cost data not available.\n', exitCode: 1 };
    }

    const data = await sessionCostsProvider();

    if (data.length === 0) {
      return { stdout: 'No session cost data yet.\n', stderr: '', exitCode: 0 };
    }

    if (args.includes('--json')) {
      return { stdout: JSON.stringify(data, null, 2) + '\n', stderr: '', exitCode: 0 };
    }

    return { stdout: formatTable(data), stderr: '', exitCode: 0 };
  });
}
