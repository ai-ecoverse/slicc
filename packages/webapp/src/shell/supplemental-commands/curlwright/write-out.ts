/**
 * `curlwright -w/--write-out` formatting.
 *
 * Supports curl's `%{variable}` substitution, the `%header{Name}` form,
 * `%%` for a literal percent, and backslash escapes. Only the variables
 * a page-context fetch can actually answer are defined — an unknown one
 * expands to nothing and is reported, rather than being echoed back as
 * if it were literal text.
 */

/** Everything a completed page-context request can say about itself. */
export interface WriteOutContext {
  urlEffective: string;
  httpCode: number;
  contentType: string;
  sizeDownload: number;
  sizeHeader: number;
  sizeUpload: number;
  method: string;
  numRedirects: number;
  timeTotalSeconds: number;
  exitCode: number;
  errorMsg: string;
  responseHeaders: Record<string, string>;
}

function secondsFormat(seconds: number): string {
  return seconds.toFixed(6);
}

function lookupVariable(name: string, ctx: WriteOutContext): string | null {
  switch (name) {
    case 'url':
    case 'url_effective':
      return ctx.urlEffective;
    case 'http_code':
    case 'response_code':
      return String(ctx.httpCode);
    case 'content_type':
      return ctx.contentType;
    case 'size_download':
      return String(ctx.sizeDownload);
    case 'size_header':
      return String(ctx.sizeHeader);
    case 'size_upload':
    case 'size_request':
      return String(ctx.sizeUpload);
    case 'method':
      return ctx.method;
    case 'num_redirects':
      return String(ctx.numRedirects);
    case 'time_total':
    case 'time_starttransfer':
      return secondsFormat(ctx.timeTotalSeconds);
    case 'exitcode':
      return String(ctx.exitCode);
    case 'errormsg':
      return ctx.errorMsg;
    case 'json':
      return JSON.stringify(writeOutJson(ctx));
    default:
      return null;
  }
}

/** The subset of curl's `%{json}` blob this command can populate honestly. */
function writeOutJson(ctx: WriteOutContext): Record<string, string | number> {
  return {
    url_effective: ctx.urlEffective,
    http_code: ctx.httpCode,
    content_type: ctx.contentType,
    size_download: ctx.sizeDownload,
    size_header: ctx.sizeHeader,
    size_upload: ctx.sizeUpload,
    method: ctx.method,
    num_redirects: ctx.numRedirects,
    time_total: ctx.timeTotalSeconds,
    exitcode: ctx.exitCode,
    errormsg: ctx.errorMsg,
  };
}

function headerValue(name: string, ctx: WriteOutContext): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(ctx.responseHeaders)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return '';
}

function unescape(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return char;
  }
}

/** Read a `{…}` group starting at `open`; returns null when unterminated. */
function readBraced(format: string, open: number): { body: string; end: number } | null {
  const close = format.indexOf('}', open);
  if (close === -1) return null;
  return { body: format.slice(open + 1, close), end: close };
}

/**
 * Expand a `--write-out` format string. Returns the rendered text plus
 * any warnings (unknown variables), which the caller sends to stderr —
 * silently dropping an unrecognized `%{…}` is how a format string ends
 * up quietly wrong.
 */
export function formatWriteOut(
  format: string,
  ctx: WriteOutContext
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let out = '';

  for (let i = 0; i < format.length; i++) {
    const char = format[i];
    if (char === '\\' && i + 1 < format.length) {
      out += unescape(format[++i]);
      continue;
    }
    if (char !== '%') {
      out += char;
      continue;
    }
    if (format[i + 1] === '%') {
      out += '%';
      i++;
      continue;
    }
    if (format[i + 1] === '{') {
      const group = readBraced(format, i + 1);
      if (!group) {
        out += char;
        continue;
      }
      const value = lookupVariable(group.body, ctx);
      if (value === null)
        warnings.push(`curlwright: unknown --write-out variable: '${group.body}'`);
      out += value ?? '';
      i = group.end;
      continue;
    }
    if (format.startsWith('%header{', i)) {
      const group = readBraced(format, i + 7);
      if (group) {
        out += headerValue(group.body, ctx);
        i = group.end;
        continue;
      }
    }
    out += char;
  }
  return { text: out, warnings };
}
