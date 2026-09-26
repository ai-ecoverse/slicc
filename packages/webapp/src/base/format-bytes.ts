/**
 * Shared byte-count → human-readable size string.
 *
 * Two bases are intentional and must be chosen explicitly at the call site:
 * - Binary (default / `formatBytesBinary`): ÷1024, units `B/KB/MB/GB/TB/PB`,
 *   one decimal once past bytes — shell commands (`hf`, `meminfo`, `df -h`).
 * - SI (`formatBytesSi` / `{ si: true }`): ÷1000, units `B/kB/MB/GB/TB`,
 *   one decimal below 10 else round — chat progress (`wc-message-view`).
 *
 * Lives in `base/` so both `shell/` and `ui/` can import without a layer back-edge.
 */

export type FormatBytesOptions = {
  /**
   * When true, use SI base-1000 with units B/kB/MB/GB/TB.
   * When false/omitted, use binary base-1024 with units B/KB/MB/GB/TB/PB.
   */
  si?: boolean;
};

/** Format a non-negative byte count. Returns '' for non-finite or negative inputs. */
export function formatBytes(bytes: number, opts: FormatBytesOptions = {}): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';

  if (opts.si) {
    if (bytes < 1000) return `${Math.round(bytes)} B`;
    const units = ['kB', 'MB', 'GB', 'TB'] as const;
    let v = bytes / 1000;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
      v /= 1000;
      i += 1;
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const;
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Binary base-1024 sizes (`KB`/`MB`/…). Prefer at shell-command call sites. */
export function formatBytesBinary(bytes: number): string {
  return formatBytes(bytes, { si: false });
}

/** SI base-1000 sizes (`kB`/`MB`/…). Prefer at chat/progress call sites. */
export function formatBytesSi(bytes: number): string {
  return formatBytes(bytes, { si: true });
}
