export interface ColorApi {
  enabled: boolean;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  gray(s: string): string;
  bold(s: string): string;
  cyan(s: string): string;
  dim(s: string): string;
}

const ANSI = {
  reset: '\u001b[0m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  gray: '\u001b[90m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
} as const;

export function createColor(opts: { isTTY: boolean; noColor: boolean }): ColorApi {
  const enabled = opts.isTTY && !opts.noColor;
  const wrap =
    (code: string) =>
    (s: string): string =>
      enabled ? `${code}${s}${ANSI.reset}` : String(s);
  return {
    enabled,
    green: wrap(ANSI.green),
    red: wrap(ANSI.red),
    yellow: wrap(ANSI.yellow),
    gray: wrap(ANSI.gray),
    bold: wrap(ANSI.bold),
    cyan: wrap(ANSI.cyan),
    dim: wrap(ANSI.dim),
  };
}
