#!/usr/bin/env node
/**
 * Run one `slicc <join-url> prompt|exec …` and capture its stdout.
 *
 * `prompt` streams the assistant's reply and exits when the turn completes;
 * `exec` runs a command in the leader's virtual shell and exits with the
 * command's status. Both are capped by a wall-clock timeout (SIGINT first —
 * the CLI turns that into an abort / SIGINT on the leader — then SIGKILL).
 * The full output always lands in a file; the `output` step output is a
 * truncated copy for small results.
 *
 * The text is handed to the CLI as `@<file>`, never as a bare argument: the
 * CLI's `readTextArg` treats a lone `@…` or `-` argument as a file/stdin
 * reference, so a literal prompt such as `@review the patch` would otherwise
 * be read as a filename. A file also sidesteps argv length limits.
 *
 * Inputs: SLICC_JOIN_URL, INPUT_VERB, INPUT_TEXT, INPUT_STDIN_FILE,
 * INPUT_OUTPUT_FILE, INPUT_TIMEOUT, INPUT_OUTPUT_LIMIT, INPUT_QUIET,
 * INPUT_FAIL_ON_ERROR.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CONNECT_RETRIES,
  CONNECT_RETRY_DELAY_MS,
  cliPath,
  ensureDir,
  fail,
  homeDir,
  input,
  isConnectFailure,
  isMain,
  joinUrl,
  setOutput,
  sleep,
  warning,
} from './gh-io.mjs';
import { parseBoolean, parseDuration, truncateForOutput } from './lib.mjs';

export const TIMEOUT_EXIT_CODE = 124;

export function runCli({ args, stdinFile, outputFile, timeoutMs, quiet, killGraceMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const stdin = stdinFile ? openSync(stdinFile, 'r') : 'ignore';
    const child = spawn(cliPath(), args, {
      stdio: [stdin, 'pipe', 'pipe'],
      env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
    });
    const sink = createWriteStream(outputFile);
    const chunks = [];
    const errChunks = [];
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      sink.write(chunk);
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errChunks.push(chunk);
      process.stderr.write(chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), killGraceMs).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      sink.end(() => {
        const exitCode = timedOut ? TIMEOUT_EXIT_CODE : (code ?? (signal ? 128 : 1));
        resolve({
          exitCode,
          timedOut,
          output: Buffer.concat(chunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        });
      });
    });
  });
}

export async function main(options = {}) {
  const url = joinUrl();
  const verb = input('verb', { required: true });
  if (verb !== 'prompt' && verb !== 'exec')
    throw new Error(`verb must be prompt|exec, got "${verb}"`);
  const text = input('text', { required: true, raw: true });
  const stdinFile = input('stdin-file');
  const timeoutMs = parseDuration(
    input('timeout', { fallback: verb === 'prompt' ? '30m' : '10m' })
  );
  const quiet = parseBoolean(input('quiet'), false);
  const failOnError = parseBoolean(input('fail-on-error'), true);
  const outputLimit = Number(input('output-limit', { fallback: String(256 * 1024) }));
  const outDir = ensureDir(join(homeDir(), 'out'));
  const stamp = `${verb}-${Date.now()}`;
  const outputFile = input('output-file') || join(outDir, `${stamp}.txt`);
  mkdirSync(dirname(outputFile), { recursive: true });
  const textFile = join(outDir, `${stamp}.in`);
  writeFileSync(textFile, text, { mode: 0o600 });

  console.log(`[slicc ${verb}] timeout=${Math.round(timeoutMs / 1000)}s output=${outputFile}`);
  const retries = options.retries ?? CONNECT_RETRIES;
  let result;
  for (let attempt = 1; ; attempt += 1) {
    result = await runCli({
      args: [url, verb, `@${textFile}`],
      stdinFile,
      outputFile,
      timeoutMs,
      quiet,
      killGraceMs: options.killGraceMs,
    });
    // A failed dial never reached the leader, so the message/command was not
    // delivered and a retry cannot double-execute anything.
    if (!result.timedOut && isConnectFailure(result.exitCode, result.stderr) && attempt < retries) {
      warning(`leader dial failed (attempt ${attempt}/${retries}); retrying`);
      await sleep(options.retryDelayMs ?? CONNECT_RETRY_DELAY_MS);
      continue;
    }
    break;
  }
  if (!quiet && result.output && !result.output.endsWith('\n')) process.stdout.write('\n');

  const { text: truncated, truncated: wasTruncated } = truncateForOutput(
    result.output,
    outputLimit
  );
  setOutput('output', truncated);
  setOutput('output-file', outputFile);
  setOutput('exit-code', result.exitCode);
  setOutput('timed-out', result.timedOut);
  setOutput('truncated', wasTruncated);
  if (result.timedOut) {
    throw new Error(`slicc ${verb} exceeded its ${Math.round(timeoutMs / 1000)}s timeout`);
  }
  if (result.exitCode !== 0 && failOnError) {
    throw new Error(`slicc ${verb} exited with status ${result.exitCode}`);
  }
  return result;
}

// The direct-run trampoline: unreachable in-process (tests import `main`), so
// it is excluded from coverage rather than faked through a subprocess.
/* v8 ignore start */
if (isMain(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
/* v8 ignore stop */
