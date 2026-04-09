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

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function truncModel(model: string, maxLen: number): string {
  if (model.length <= maxLen) return model;
  return model.slice(0, maxLen - 3) + '...';
}

function formatTable(data: ScoopCostData[]): string {
  const lines: string[] = [];
  lines.push('Session Cost Breakdown:\n');

  const hdr =
    '  Agent              Model                    Tokens (in/out)    Cache (r/w)       Cost';
  const sep =
    '  ─────────────────────────────────────────────────────────────────────────────────────────';

  lines.push(hdr);
  lines.push(sep);

  let totIn = 0,
    totOut = 0,
    totCR = 0,
    totCW = 0,
    totCost = 0;

  for (const d of data) {
    const label = d.type === 'cone' ? `${d.name} (cone)` : `${d.name} (scoop)`;
    const agent = label.padEnd(19);
    const model = truncModel(d.model, 24).padEnd(24);
    const tokens = `${fmtNum(d.usage.input)} / ${fmtNum(d.usage.output)}`;
    const tokenCol = tokens.padEnd(18);
    const cache = `${fmtNum(d.usage.cacheRead)} / ${fmtNum(d.usage.cacheWrite)}`;
    const cacheCol = cache.padEnd(17);
    const cost = fmtCost(d.usage.cost.total);

    lines.push(`  ${agent} ${model} ${tokenCol} ${cacheCol} ${cost}`);

    totIn += d.usage.input;
    totOut += d.usage.output;
    totCR += d.usage.cacheRead;
    totCW += d.usage.cacheWrite;
    totCost += d.usage.cost.total;
  }

  lines.push(sep);

  const totalAgent = 'Total'.padEnd(19);
  const totalModel = ''.padEnd(24);
  const totalTokens = `${fmtNum(totIn)} / ${fmtNum(totOut)}`.padEnd(18);
  const totalCache = `${fmtNum(totCR)} / ${fmtNum(totCW)}`.padEnd(17);
  const totalCost = fmtCost(totCost);

  lines.push(`  ${totalAgent} ${totalModel} ${totalTokens} ${totalCache} ${totalCost}`);

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
