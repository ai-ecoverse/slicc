/**
 * `meminfo` — agent-cluster memory diagnostics via
 * `performance.measureUserAgentSpecificMemory()`. The API is gated on a
 * cross-origin-isolated runtime, which the hosted leader has via
 * `Document-Isolation-Policy` (per-document, no COOP/COEP); embedded
 * floats (Cherry, spoon/Electron) can never be isolated and get an
 * explanatory error instead. Running in the kernel worker, the
 * measurement covers the kernel's agent cluster — the kernel itself
 * plus its same-cluster dedicated workers (realms, vpod, ffmpeg) —
 * which is exactly the population the OOM investigations care about.
 *
 * The browser adds a randomized delay before resolving (an
 * anti-fingerprinting measure), so a call can take a few seconds.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

/** One attribution row of the UA memory breakdown. */
export interface MemoryAttribution {
  url?: string;
  scope?: string;
  container?: { id?: string; src?: string };
}

export interface MemoryBreakdownEntry {
  bytes: number;
  types: string[];
  attribution: MemoryAttribution[];
}

export interface MemoryMeasurement {
  bytes: number;
  breakdown: MemoryBreakdownEntry[];
}

type CmdResult = { stdout: string; stderr: string; exitCode: number };

const HELP = `meminfo - agent-cluster memory diagnostics

Usage:
  meminfo           Human-readable breakdown (bytes, scope, types, url)
  meminfo --json    Raw performance.measureUserAgentSpecificMemory() result

Notes:
  - Requires a cross-origin-isolated runtime (the hosted leader is, via
    Document-Isolation-Policy). Embedded floats cannot be isolated and
    report why instead.
  - The browser randomizes measurement timing — expect a short delay.
`;

export interface MeminfoDeps {
  /**
   * Measurement seam. Tests inject a fake; production resolves
   * `performance.measureUserAgentSpecificMemory` at exec time (it only
   * exists on isolated runtimes).
   */
  measure?: () => Promise<MemoryMeasurement>;
  /** Isolation probe seam. Defaults to `globalThis.crossOriginIsolated`. */
  isIsolated?: () => boolean;
}

function fail(msg: string): CmdResult {
  return { stdout: '', stderr: `meminfo: ${msg}\n`, exitCode: 1 };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** Compress one breakdown entry's attribution to a display label. */
function attributionLabel(entry: MemoryBreakdownEntry): string {
  if (entry.attribution.length === 0) return '(shared)';
  return entry.attribution
    .map((a) => {
      const where = a.container?.src ?? a.container?.id ?? a.url ?? '?';
      return a.scope ? `${a.scope} ${where}` : where;
    })
    .join(', ');
}

function resolveNativeMeasure(): (() => Promise<MemoryMeasurement>) | null {
  const perf = globalThis.performance as
    | { measureUserAgentSpecificMemory?: () => Promise<MemoryMeasurement> }
    | undefined;
  const fn = perf?.measureUserAgentSpecificMemory;
  return fn ? fn.bind(perf) : null;
}

/**
 * Strict argv: only `--json` is defined. A typo like `--jsoon` must fail
 * fast, not silently wait out the randomized measurement and hand an
 * automation caller the wrong output format.
 */
function parseMeminfoArgs(
  args: readonly string[]
): { help: true } | { help: false; json: boolean } | { error: string } {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return { help: true };
  let json = false;
  for (const arg of args) {
    if (arg !== '--json') return { error: `unknown option '${arg}' — see \`meminfo --help\`` };
    json = true;
  }
  return { help: false, json };
}

function renderHuman(result: MemoryMeasurement): string {
  const lines = [`total: ${formatBytes(result.bytes)}`];
  const rows = [...result.breakdown]
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  if (rows.length > 0) {
    lines.push('', 'BYTES      TYPES                ATTRIBUTION');
    for (const entry of rows) {
      lines.push(
        `${formatBytes(entry.bytes).padEnd(10)} ${entry.types.join(',').padEnd(20)} ${attributionLabel(entry)}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function createMeminfoCommand(deps: MeminfoDeps = {}): Command {
  return defineCommand('meminfo', async (args) => {
    const parsed = parseMeminfoArgs(args);
    if ('error' in parsed) return fail(parsed.error);
    if (parsed.help) return { stdout: HELP, stderr: '', exitCode: 0 };

    const isolated = deps.isIsolated ? deps.isIsolated() : globalThis.crossOriginIsolated === true;
    const measure = deps.measure ?? resolveNativeMeasure();
    if (!isolated && !deps.measure) {
      return fail(
        'memory measurement requires a cross-origin-isolated runtime (Document-Isolation-Policy) — this runtime is not isolated'
      );
    }
    if (!measure) {
      return fail('performance.measureUserAgentSpecificMemory is not available in this browser');
    }

    let result: MemoryMeasurement;
    try {
      result = await measure();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    if (parsed.json) {
      return { stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: renderHuman(result), stderr: '', exitCode: 0 };
  });
}
