/**
 * `wasi-stats.ts` — `SLICC_WASI_STATS=1`: a WASI program's calls counted and
 * timed, `strace -c` style, and written to its stderr when it ends. Imports
 * (`wasi.*`), the sync-fs bridge requests they make (`fs.*`) and kernel
 * syscalls (`kernel.*`) are each their own rows, so a slow start-up shows
 * whether it is many calls or slow ones, and on which side of the bridge.
 */

interface Row {
  n: number;
  ms: number;
  max: number;
}

export class WasiStats {
  private readonly rows = new Map<string, Row>();
  private readonly phases: Array<[string, number]> = [];
  private mark = performance.now();

  /** `table` with each function counted under `tag.name`. */
  wrap<T extends object>(tag: string, table: T): T {
    return Object.fromEntries(
      Object.entries(table).map(([name, value]) => {
        if (typeof value !== 'function') return [name, value];
        const fn = value as (...args: unknown[]) => unknown;
        const key = `${tag}.${name}`;
        return [name, (...args: unknown[]) => this.time(key, () => fn.apply(table, args))];
      })
    ) as T;
  }

  /** `fn()`, counted and timed under `key`. */
  time<T>(key: string, fn: () => T): T {
    const t = performance.now();
    try {
      return fn();
    } finally {
      this.count(key, performance.now() - t);
    }
  }

  /** The time since the last phase ended, as `name` (instantiate, run). */
  phase(name: string): void {
    const now = performance.now();
    this.phases.push([name, now - this.mark]);
    this.mark = now;
  }

  private count(key: string, ms: number): void {
    const row = this.rows.get(key) ?? { n: 0, ms: 0, max: 0 };
    row.n++;
    row.ms += ms;
    row.max = Math.max(row.max, ms);
    this.rows.set(key, row);
  }

  /** The table: phases, then calls by total time. */
  report(): string {
    const ms = (v: number) => v.toFixed(1).padStart(9);
    const lines = this.phases.map(([name, t]) => `${ms(t)} ms  ${name}`);
    lines.push(`${'total ms'.padStart(12)} ${'calls'.padStart(7)} ${'max ms'.padStart(9)}  call`);
    const sorted = [...this.rows].sort((a, b) => b[1].ms - a[1].ms);
    for (const [key, row] of sorted) {
      lines.push(`${ms(row.ms)}   ${String(row.n).padStart(7)} ${ms(row.max)}  ${key}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
