/**
 * Unit coverage for `curlwright`'s pure pieces: the argv grammar, the
 * `--write-out` formatter, and the response-shaping helpers. The
 * end-to-end behavior lives in `curlwright-command.test.ts`; these tests
 * pin the corners of curl's syntax that are easy to get subtly wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  isParseFailure,
  parseCurlwrightArgs,
  validateHeaders,
} from '../../../src/shell/supplemental-commands/curlwright/parse-args.js';
import {
  BINARY_OUTPUT_WARNING,
  formatHeaderBlock,
  headerBlockSize,
  looksBinary,
  remoteName,
  statusLine,
} from '../../../src/shell/supplemental-commands/curlwright/response.js';
import type { WriteOutContext } from '../../../src/shell/supplemental-commands/curlwright/write-out.js';
import { formatWriteOut } from '../../../src/shell/supplemental-commands/curlwright/write-out.js';

function parse(args: string[]) {
  const parsed = parseCurlwrightArgs(args);
  if (isParseFailure(parsed)) throw new Error(`unexpected failure: ${parsed.message}`);
  return parsed;
}

function failure(args: string[]) {
  const parsed = parseCurlwrightArgs(args);
  if (!isParseFailure(parsed)) throw new Error('expected a parse failure');
  return parsed;
}

describe('curlwright argv grammar', () => {
  it('bundles short booleans and lets the last one take a value', () => {
    const opts = parse(['-sSio', '/tmp/x', 'https://a.example/']);
    expect(opts.silent).toBe(true);
    expect(opts.showError).toBe(true);
    expect(opts.include).toBe(true);
    expect(opts.output).toBe('/tmp/x');
    expect(opts.url).toBe('https://a.example/');
  });

  it('accepts an attached short value (-XPOST) and --flag=value', () => {
    expect(parse(['-XPOST', 'https://a.example/']).requestMethod).toBe('POST');
    expect(parse(['--request=PUT', 'https://a.example/']).requestMethod).toBe('PUT');
  });

  it('takes a value-flag argument verbatim even when it looks like a flag', () => {
    const opts = parse(['-d', '--fail', 'https://a.example/']);
    expect(opts.data).toEqual([{ kind: 'ascii', value: '--fail' }]);
    expect(opts.failOnError).toBe(false);
  });

  it('stops option parsing at --', () => {
    const opts = parse(['-s', '--', '-not-a-flag']);
    expect(opts.url).toBe('-not-a-flag');
    expect(opts.silent).toBe(true);
  });

  it('keeps repeated -H and -d in order', () => {
    const opts = parse([
      '-H',
      'A: 1',
      '-H',
      'B: 2',
      '-d',
      'x=1',
      '-d',
      'y=2',
      'https://a.example/',
    ]);
    expect(opts.headers.map((h) => h.name)).toEqual(['A', 'B']);
    expect(opts.data.map((d) => d.value)).toEqual(['x=1', 'y=2']);
  });

  it('reads -H forms: name/value, empty via ";", and curl\'s unset via a bare colon', () => {
    const opts = parse(['-H', 'X-A: 1', '-H', 'X-B;', '-H', 'X-C:', 'https://a.example/']);
    expect(opts.headers[0]).toEqual({ name: 'X-A', value: '1', unset: false });
    expect(opts.headers[1]).toEqual({ name: 'X-B', value: '', unset: false });
    expect(opts.headers[2].unset).toBe(true);
  });

  it('maps every --data-* variant to its kind', () => {
    const opts = parse([
      '--data-raw',
      'a',
      '--data-binary',
      'b',
      '--data-ascii',
      'c',
      '--data-urlencode',
      'd',
      '--json',
      '{}',
      'https://a.example/',
    ]);
    expect(opts.data.map((d) => d.kind)).toEqual(['raw', 'binary', 'ascii', 'urlencode', 'json']);
  });

  it('treats -L as a no-op because redirects are always followed', () => {
    expect(parse(['-L', 'https://a.example/']).url).toBe('https://a.example/');
  });

  it('rejects a value flag with no value', () => {
    expect(failure(['-H']).message).toContain('-H requires a value');
    expect(failure(['--header']).message).toContain('--header requires a value');
  });

  it('rejects a non-positive --max-time', () => {
    expect(failure(['-m', 'soon', 'https://a.example/']).message).toContain('positive number');
    expect(failure(['-m', '0', 'https://a.example/']).message).toContain('positive number');
    expect(parse(['-m', '1.5', 'https://a.example/']).maxTimeSeconds).toBe(1.5);
  });

  it('names each unsupported flag with the reason it cannot work', () => {
    expect(failure(['--interface', 'eth0']).message).toContain('outgoing interface');
    expect(failure(['-b', 'a=1']).message).toContain('cookie-set');
    expect(failure(['-A', 'curl/8']).message).toContain('forbidden header');
    expect(failure(['--http2']).message).toContain('HTTP version');
    expect(failure(['--unknown-thing']).message).toContain('unknown option --unknown-thing');
    expect(failure(['-Z']).message).toContain('unknown option -Z');
  });

  it('rejects headers the browser strips, including the Sec-/Proxy- prefixes', () => {
    expect(validateHeaders([{ name: 'Referer', value: 'x', unset: false }])?.message).toContain(
      '-e/--referer'
    );
    expect(
      validateHeaders([{ name: 'sec-fetch-mode', value: 'cors', unset: false }])?.message
    ).toContain('reserved for the browser');
    expect(
      validateHeaders([{ name: 'Proxy-Authorization', value: 'x', unset: false }])?.message
    ).toContain('proxying');
    expect(validateHeaders([{ name: 'X-Fine', value: '1', unset: false }])).toBeNull();
  });
});

describe('curlwright --write-out', () => {
  const ctx: WriteOutContext = {
    urlEffective: 'https://a.example/final',
    httpCode: 204,
    contentType: 'text/plain',
    sizeDownload: 12,
    sizeHeader: 34,
    sizeUpload: 56,
    method: 'PUT',
    numRedirects: 1,
    timeTotalSeconds: 0.5,
    exitCode: 0,
    errorMsg: '',
    responseHeaders: { 'Content-Type': 'text/plain', etag: 'W/"7"' },
  };

  it('expands every documented variable', () => {
    const { text } = formatWriteOut(
      '%{url_effective}|%{url}|%{http_code}|%{response_code}|%{content_type}|' +
        '%{size_download}|%{size_header}|%{size_upload}|%{size_request}|%{method}|' +
        '%{num_redirects}|%{time_total}|%{time_starttransfer}|%{exitcode}|%{errormsg}',
      ctx
    );
    expect(text).toBe(
      'https://a.example/final|https://a.example/final|204|204|text/plain|' +
        '12|34|56|56|PUT|1|0.500000|0.500000|0|'
    );
  });

  it('reads a response header case-insensitively and blanks a missing one', () => {
    expect(formatWriteOut('%header{content-type}', ctx).text).toBe('text/plain');
    expect(formatWriteOut('%header{ETag}', ctx).text).toBe('W/"7"');
    expect(formatWriteOut('[%header{x-absent}]', ctx).text).toBe('[]');
  });

  it('handles escapes, %% and unterminated groups', () => {
    expect(formatWriteOut('a\\tb\\nc\\rd\\qe', ctx).text).toBe('a\tb\nc\rdqe');
    expect(formatWriteOut('100%%', ctx).text).toBe('100%');
    expect(formatWriteOut('%{unterminated', ctx).text).toBe('%{unterminated');
    expect(formatWriteOut('%header{unterminated', ctx).text).toBe('%header{unterminated');
    expect(formatWriteOut('bare % sign', ctx).text).toBe('bare % sign');
    expect(formatWriteOut('trailing \\', ctx).text).toBe('trailing \\');
  });

  it('emits %{json} as a machine-readable summary', () => {
    const parsed = JSON.parse(formatWriteOut('%{json}', ctx).text) as Record<string, unknown>;
    expect(parsed.http_code).toBe(204);
    expect(parsed.url_effective).toBe('https://a.example/final');
  });

  it('warns on an unknown variable and expands it to nothing', () => {
    const { text, warnings } = formatWriteOut('<%{bogus}>', ctx);
    expect(text).toBe('<>');
    expect(warnings).toEqual(["curlwright: unknown --write-out variable: 'bogus'"]);
  });
});

describe('curlwright response helpers', () => {
  it('synthesizes a status line with and without a reason phrase', () => {
    expect(statusLine(200, 'OK')).toBe('HTTP/1.1 200 OK');
    expect(statusLine(204, '')).toBe('HTTP/1.1 204');
  });

  it('formats a CRLF header block closed by a blank line', () => {
    const block = formatHeaderBlock(200, 'OK', { 'content-type': 'text/plain' });
    expect(block).toBe('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n');
    expect(headerBlockSize(200, 'OK', { 'content-type': 'text/plain' })).toBe(block.length);
  });

  it('calls bytes binary on a NUL or on invalid UTF-8, not on emoji', () => {
    expect(looksBinary(new TextEncoder().encode('héllo 🍦'))).toBe(false);
    expect(looksBinary(new Uint8Array([0x61, 0x00, 0x62]))).toBe(true);
    expect(looksBinary(new Uint8Array([0xff, 0xfe]))).toBe(true);
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  it('derives -O names from a URL path, and reports when it cannot', () => {
    expect(remoteName('https://a.example/files/report.csv?v=1')).toBe('report.csv');
    expect(remoteName('https://a.example/files/')).toBe('files');
    expect(remoteName('https://a.example/')).toBeNull();
    expect(remoteName('/api/data.json')).toBe('data.json');
  });

  it("warns about binary stdout in curl's own words", () => {
    expect(BINARY_OUTPUT_WARNING).toContain('Binary output can mess up your terminal');
  });
});
