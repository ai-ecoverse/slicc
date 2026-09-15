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
 * Inputs: SLICC_JOIN_URL, INPUT_VERB, INPUT_TEXT, INPUT_STDIN_FILE,
 * INPUT_OUTPUT_FILE, INPUT_TIMEOUT, INPUT_OUTPUT_LIMIT, INPUT_QUIET,
 * INPUT_FAIL_ON_ERROR.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, openSync } from 'node:fs';
import { join } from 'node:path';
import { cliPath, ensureDir, fail, homeDir, input, joinUrl, setOutput } from './gh-io.mjs';
import { parseBoolean, parseDuration, truncateForOutput } from './lib.mjs';

const TIMEOUT_EXIT_CODE = 124;

function runCli({ args, stdinFile, outputFile, timeoutMs, quiet }) {
  return new Promise((resolve, reject) => {
    const stdin = stdinFile ? openSync(stdinFile, 'r') : 'ignore';
    const child = spawn(cliPath(), args, {
      stdio: [stdin, 'pipe', 'inherit'],
      env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
    });
    const sink = createWriteStream(outputFile);
    const chunks = [];
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      sink.write(chunk);
      if (!quiet) process.stdout.write(chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      sink.end(() => {
        const exitCode = timedOut ? TIMEOUT_EXIT_CODE : (code ?? (signal ? 128 : 1));
        resolve({ exitCode, timedOut, output: Buffer.concat(chunks).toString('utf8') });
      });
    });
  });
}

async function main() {
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
  const outputFile =
    input('output-file') || join(ensureDir(join(homeDir(), 'out')), `${verb}-${Date.now()}.txt`);

  console.log(`[slicc ${verb}] timeout=${Math.round(timeoutMs / 1000)}s output=${outputFile}`);
  const result = await runCli({ args: [url, verb, text], stdinFile, outputFile, timeoutMs, quiet });
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
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
