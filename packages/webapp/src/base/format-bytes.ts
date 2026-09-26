export type FormatBytesOptions = {
  si?: boolean;
};

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

  if (bytes < 1024) {
    if (Number.isInteger(bytes)) return `${bytes} B`;
    if (bytes >= 0.1) return `${bytes.toFixed(1)} B`;
    if (bytes > 0) return `${Math.max(0.01, Number(bytes.toFixed(2)))} B`;
    return '0 B';
  }
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const;
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatBytesBinary(bytes: number): string {
  return formatBytes(bytes, { si: false });
}

export function formatBytesSi(bytes: number): string {
  return formatBytes(bytes, { si: true });
}
