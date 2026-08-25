/**
 * `curlwright` — curl's argument surface, executed inside a Playwright
 * tab (issue #2406). This is the lazily-imported implementation;
 * `../curlwright-command.ts` is the thin registration stub that keeps
 * all of it out of the kernel worker's boot-critical graph.
 *
 * SLICC's own guidance is that an app's backend should be called from
 * the page context, because that is the only place with real cookies,
 * the correct origin and the full browser session. `browser.fetch()`
 * gave `.jsh` scripts that power; the shell — where the discovery
 * actually happens — had nothing, so every page-context request meant
 * writing a temp `.js` file, running `eval-file`, and parsing a
 * JSON summary back out of stdout. Binary responses could not be
 * retrieved at all.
 *
 * This command is that dance, collapsed into the flags people already
 * know. The response body always crosses the bridge as base64 bytes, so
 * `-o` writes a byte-exact file and text is decoded exactly once.
 */

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
import { formatWriteOut } from './write-out.js';

/** The CDP-backed browser port `curlwright` drives, named for the stub. */
export type CurlwrightBrowser = PlaywrightHandlerCtx['browser'];
type BrowserAPI = CurlwrightBrowser;
type CmdResult = { stdout: string; stderr: string; exitCode: number };

/** curl's exit code for a failed local write. */
const CURL_WRITE_ERROR = 23;

/** Accumulates the two stderr streams so `-s` can drop only one of them. */
interface Streams {
  stdout: string;
  /** `-v` traces; printed even under `-s`, like curl. */
  trace: string;
  /** Errors and warnings; suppressed by `-s` unless `-S`. */
  messages: string;
}

function fail(message: string, exitCode: number): CmdResult {
  return { stdout: '', stderr: `${message}\n`, exitCode };
}

/** Map a thrown page-side error onto curl's exit-code vocabulary. */
function classifyFetchError(err: unknown): { message: string; exitCode: number } {
  const raw = err instanceof Error ? err.message : String(err);
  if (/TimeoutError|signal timed out|aborted/i.test(raw)) {
    return { message: 'curlwright: (28) Operation timed out', exitCode: 28 };
  }
  if (/Failed to fetch|NetworkError|TypeError/i.test(raw)) {
    return { message: `curlwright: (7) Failed to fetch — ${raw}`, exitCode: 7 };
  }
  return { message: `curlwright: ${raw}`, exitCode: 1 };
}

/** Run the injected script in the chosen tab (optionally a child frame). */
async function runPageFetch(
  browser: BrowserAPI,
  targetId: string,
  frameId: string | null,
  url: string,
  fetchOptions: BrowserFetchOptions
): Promise<BrowserFetchResult> {
  const script = await buildBrowserFetchScript(url, fetchOptions);
  const raw = await browser.withTab(targetId, async () => {
    if (!frameId) return browser.evaluate(script);
    return browser.evaluateInFrame(frameId, script, { world: 'main' });
  });
  return raw as BrowserFetchResult;
}

/** Write the response body wherever `-o`/`-O` pointed. */
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

/** Where the body should go: a VFS path, `'-'` for stdout, or null. */
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
  // `-o -` forces the bytes onto stdout; without it, curl's guard applies.
  if (target === null && looksBinary(bytes)) {
    streams.messages += BINARY_OUTPUT_WARNING;
    return 0;
  }
  streams.stdout += new TextDecoder().decode(bytes);
  return 0;
}

/** Append `-w` output, after the exit code is known (`%{exitcode}`). */
function appendWriteOut(
  opts: CurlwrightOptions,
  streams: Streams,
  request: PreparedRequest,
  result: BrowserFetchResult,
  bytes: Uint8Array,
  elapsedMs: number,
  exitCode: number
): void {
  if (opts.writeOut === null) return;
  const rendered = formatWriteOut(opts.writeOut, {
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
  });
  streams.stdout += rendered.text;
  for (const warning of rendered.warnings) streams.messages += `${warning}\n`;
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
  if (opts.dumpHeader !== null) {
    const block = formatHeaderBlock(result.status, result.statusText, result.headers);
    const error = await writeBodyFile(ctx, opts.dumpHeader, new TextEncoder().encode(block));
    if (error) streams.messages += `${error}\n`;
  }

  const bytes = decodeBody(result.body, result.bodyEncoding);
  let exitCode = 0;
  if (opts.failOnError && result.status >= 400) {
    streams.messages += `curlwright: (22) The requested URL returned error: ${result.status}\n`;
    exitCode = 22;
  } else if (!opts.head) {
    exitCode = await emitBody(ctx, opts, streams, bytes, request.url);
  }

  appendWriteOut(opts, streams, request, result, bytes, elapsedMs, exitCode);
  const quiet = opts.silent && !opts.showError;
  return {
    stdout: streams.stdout,
    stderr: streams.trace + (quiet ? '' : streams.messages),
    exitCode,
  };
}

/** Parse argv and resolve the body; either yields a request or a result. */
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

/**
 * Run one `curlwright` invocation. `browser` is optional so the command
 * stays discoverable (and explains itself) on floats with no CDP backend.
 */
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
      request.fetchOptions
    );
  } catch (err) {
    const classified = classifyFetchError(err);
    const quiet = opts.silent && !opts.showError;
    return {
      stdout: '',
      stderr: trace + (quiet ? '' : `${classified.message}\n`),
      exitCode: classified.exitCode,
    };
  }
  const rendered = await renderOutcome(ctx, opts, request, result, Date.now() - startedAt);
  return { ...rendered, stderr: trace + rendered.stderr };
}
