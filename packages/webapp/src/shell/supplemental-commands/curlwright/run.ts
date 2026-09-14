import type { CommandContext } from 'just-bash';
import type {
  BrowserFetchOptions,
  BrowserFetchResult,
} from '../../../kernel/realm/realm-browser-fetch.js';
import { buildBrowserFetchScript } from '../../../kernel/realm/realm-browser-fetch.js';
import type { PlaywrightHandlerCtx } from '../playwright/types.js';
import { resolveBody } from './body.js';
import { CURLWRIGHT_HELP } from './help.js';
import type { CurlwrightOptions } from './parse-args.js';
import { isParseFailure, parseCurlwrightArgs, validateHeaders } from './parse-args.js';
import type { PreparedRequest } from './request.js';
import { formatRequestTrace, formatResponseTrace, prepareRequest } from './request.js';
import {
  BINARY_OUTPUT_WARNING,
  decodeBody,
  formatHeaderBlock,
  headerBlockSize,
  looksBinary,
  remoteName,
  statusLine,
} from './response.js';
import { resolveCurlwrightTab } from './tab.js';
import type { WriteOutContext } from './write-out.js';
import { formatWriteOut } from './write-out.js';

export type CurlwrightBrowser = PlaywrightHandlerCtx['browser'];
type BrowserAPI = CurlwrightBrowser;
type CmdResult = { stdout: string; stderr: string; exitCode: number };

const CURL_WRITE_ERROR = 23;

const ABORTED_EXIT_CODE = 130;

function abandoned(step: string, trace: string, opts: CurlwrightOptions): CmdResult {
  const quiet = opts.silent && !opts.showError;
  return {
    stdout: '',
    stderr: trace + (quiet ? '' : `curlwright: aborted while ${step}\n`),
    exitCode: ABORTED_EXIT_CODE,
  };
}

interface Streams {
  stdout: string;

  trace: string;

  messages: string;
}

function fail(message: string, exitCode: number): CmdResult {
  return { stdout: '', stderr: `${message}\n`, exitCode };
}

function classifyFetchError(err: unknown): {
  message: string;
  errorMsg: string;
  exitCode: number;
} {
  const raw = err instanceof Error ? err.message : String(err);
  if (/TimeoutError|signal timed out|aborted/i.test(raw)) {
    const errorMsg = 'Operation timed out';
    return { message: `curlwright: (28) ${errorMsg}`, errorMsg, exitCode: 28 };
  }
  if (/Failed to fetch|NetworkError|TypeError/i.test(raw)) {
    const errorMsg = `Failed to fetch — ${raw}`;
    return { message: `curlwright: (7) ${errorMsg}`, errorMsg, exitCode: 7 };
  }
  return { message: `curlwright: ${raw}`, errorMsg: raw, exitCode: 1 };
}

async function runPageFetch(
  browser: BrowserAPI,
  targetId: string,
  frameId: string | null,
  url: string,
  fetchOptions: BrowserFetchOptions,
  signal: AbortSignal | undefined
): Promise<BrowserFetchResult> {
  const script = await buildBrowserFetchScript(url, fetchOptions);

  const raw = await browser.withTab(
    targetId,
    async (page) => {
      if (!frameId) return page.evaluate(script);
      return page.evaluateInFrame(frameId, script, { world: 'main' });
    },
    { signal }
  );
  return raw as BrowserFetchResult;
}

async function writeBodyFile(
  ctx: CommandContext,
  target: string,
  bytes: Uint8Array
): Promise<string | null> {
  try {
    await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, target), bytes);
    return null;
  } catch (err) {
    return `curlwright: (23) failed writing ${target}: ${err instanceof Error ? err.message : err}`;
  }
}

function outputTarget(opts: CurlwrightOptions, url: string): string | null | { error: string } {
  if (opts.output !== null) return opts.output;
  if (!opts.remoteName) return null;
  const name = remoteName(url);
  return name ?? { error: 'curlwright: -O requires a URL with a file name in its path' };
}

async function emitBody(
  ctx: CommandContext,
  opts: CurlwrightOptions,
  streams: Streams,
  bytes: Uint8Array,
  url: string
): Promise<number> {
  const target = outputTarget(opts, url);
  if (target !== null && typeof target === 'object') {
    streams.messages += `${target.error}\n`;
    return 2;
  }
  if (target !== null && target !== '-') {
    const error = await writeBodyFile(ctx, target, bytes);
    if (error) {
      streams.messages += `${error}\n`;
      return CURL_WRITE_ERROR;
    }
    return 0;
  }

  if (target === null && looksBinary(bytes)) {
    streams.messages += BINARY_OUTPUT_WARNING;
    return 0;
  }
  streams.stdout += new TextDecoder().decode(bytes);
  return 0;
}

function appendWriteOut(opts: CurlwrightOptions, streams: Streams, ctx: WriteOutContext): void {
  if (opts.writeOut === null) return;
  const rendered = formatWriteOut(opts.writeOut, ctx);
  streams.stdout += rendered.text;
  for (const warning of rendered.warnings) streams.messages += `${warning}\n`;
}

function completedWriteOutContext(
  request: PreparedRequest,
  result: BrowserFetchResult,
  bytes: Uint8Array,
  elapsedMs: number,
  exitCode: number
): WriteOutContext {
  return {
    urlEffective: result.url || request.url,
    httpCode: result.status,
    contentType: result.headers['content-type'] ?? '',
    sizeDownload: bytes.length,
    sizeHeader: headerBlockSize(result.status, result.statusText, result.headers),
    sizeUpload: request.uploadSize,
    method: request.method,
    numRedirects: result.redirected ? 1 : 0,
    timeTotalSeconds: elapsedMs / 1000,
    exitCode,
    errorMsg: '',
    responseHeaders: result.headers,
  };
}

function failedWriteOutContext(
  request: PreparedRequest,
  elapsedMs: number,
  exitCode: number,
  errorMsg: string
): WriteOutContext {
  return {
    urlEffective: request.url,
    httpCode: 0,
    contentType: '',
    sizeDownload: 0,
    sizeHeader: 0,
    sizeUpload: request.uploadSize,
    method: request.method,
    numRedirects: 0,
    timeTotalSeconds: elapsedMs / 1000,
    exitCode,
    errorMsg,
    responseHeaders: {},
  };
}

async function renderOutcome(
  ctx: CommandContext,
  opts: CurlwrightOptions,
  request: PreparedRequest,
  result: BrowserFetchResult,
  elapsedMs: number
): Promise<CmdResult> {
  const streams: Streams = { stdout: '', trace: '', messages: '' };
  const line = statusLine(result.status, result.statusText);
  if (opts.verbose) streams.trace += formatResponseTrace(line, result.headers);
  if (opts.include || opts.head) {
    streams.stdout += formatHeaderBlock(result.status, result.statusText, result.headers);
  }

  let dumpExitCode = 0;
  if (opts.dumpHeader !== null) {
    const block = formatHeaderBlock(result.status, result.statusText, result.headers);
    const error = await writeBodyFile(ctx, opts.dumpHeader, new TextEncoder().encode(block));
    if (error) {
      streams.messages += `${error}\n`;
      dumpExitCode = CURL_WRITE_ERROR;
    }
  }

  const bytes = decodeBody(result.body, result.bodyEncoding);
  let exitCode = 0;
  if (opts.failOnError && result.status >= 400) {
    streams.messages += `curlwright: (22) The requested URL returned error: ${result.status}\n`;
    exitCode = 22;
  } else if (!opts.head) {
    exitCode = await emitBody(ctx, opts, streams, bytes, request.url);
  }
  if (exitCode === 0) exitCode = dumpExitCode;

  appendWriteOut(
    opts,
    streams,
    completedWriteOutContext(request, result, bytes, elapsedMs, exitCode)
  );
  const quiet = opts.silent && !opts.showError;
  return {
    stdout: streams.stdout,
    stderr: streams.trace + (quiet ? '' : streams.messages),
    exitCode,
  };
}

async function prepare(
  ctx: CommandContext,
  args: string[]
): Promise<{ opts: CurlwrightOptions; request: PreparedRequest } | CmdResult> {
  const parsed = parseCurlwrightArgs(args);
  if (isParseFailure(parsed)) return fail(parsed.message, parsed.exitCode);
  if (parsed.help) return { stdout: CURLWRIGHT_HELP, stderr: '', exitCode: 0 };
  if (parsed.url === null) return fail('curlwright: no URL specified', 2);

  const headerFailure = validateHeaders(parsed.headers);
  if (headerFailure) return fail(headerFailure.message, headerFailure.exitCode);

  const body = await resolveBody(ctx, parsed.data, parsed.form);
  if ('exitCode' in body) return fail(body.message, body.exitCode);

  const request = prepareRequest(parsed, body);
  if ('message' in request) return fail(request.message, request.exitCode);
  return { opts: parsed, request };
}

export async function runCurlwright(
  browser: BrowserAPI | null | undefined,
  args: string[],
  ctx: CommandContext
): Promise<CmdResult> {
  if (args.length === 0) {
    return fail("curlwright: no URL specified\nRun 'curlwright --help' for usage.", 2);
  }
  const prepared = await prepare(ctx, args);
  if ('exitCode' in prepared) return prepared;
  const { opts, request } = prepared;

  if (!browser) {
    return fail('curlwright: browser APIs are unavailable in this environment', 1);
  }
  if (ctx.signal?.aborted) return abandoned('about to pick a tab', '', opts);
  const tab = await resolveCurlwrightTab(browser, request.url, opts.tab);
  if ('message' in tab) return fail(tab.message, 2);

  const trace = opts.verbose ? formatRequestTrace(request) : '';
  const startedAt = Date.now();
  let result: BrowserFetchResult;
  try {
    result = await runPageFetch(
      browser,
      tab.targetId,
      opts.frame,
      request.url,
      request.fetchOptions,
      ctx.signal
    );
  } catch (err) {
    if (ctx.signal?.aborted) return abandoned(`requesting ${request.url}`, trace, opts);
    const classified = classifyFetchError(err);
    const streams: Streams = { stdout: '', trace, messages: `${classified.message}\n` };
    appendWriteOut(
      opts,
      streams,
      failedWriteOutContext(
        request,
        Date.now() - startedAt,
        classified.exitCode,
        classified.errorMsg
      )
    );
    const quiet = opts.silent && !opts.showError;
    return {
      stdout: streams.stdout,
      stderr: streams.trace + (quiet ? '' : streams.messages),
      exitCode: classified.exitCode,
    };
  }

  if (ctx.signal?.aborted)
    return abandoned(`rendering the response from ${request.url}`, trace, opts);
  const rendered = await renderOutcome(ctx, opts, request, result, Date.now() - startedAt);
  return { ...rendered, stderr: trace + rendered.stderr };
}
