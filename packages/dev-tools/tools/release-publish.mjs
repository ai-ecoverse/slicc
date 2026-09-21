#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFER_MESSAGE =
  '[release-publish] main moved during prepare; the version-commit push was rejected. ' +
  'Deferring — the push that moved main, or the schedule catch-up, publishes from the new tip.';

const MISSING_ISSUE_MESSAGE =
  '[release-publish] @semantic-release/github success could not resolve a referenced ' +
  'GitHub issue after publish already completed. Treating the job as successful so a ' +
  'phantom #NNNN cannot red the pipeline.';

export function isStaleReleasePush(output) {
  const text = String(output ?? '');
  const gitPluginFailed =
    text.includes('Failed step "prepare" of plugin "@semantic-release/git"') ||
    /Command failed with exit code 1: git push --tags\b/.test(text);
  const rejected =
    text.includes('(fetch first)') ||
    text.includes('(non-fast-forward)') ||
    text.includes('Updates were rejected because the remote contains work that you do');
  return gitPluginFailed && rejected;
}

export function isMissingGithubIssueSuccess(output) {
  const text = String(output ?? '');
  const successFailed = text.includes('Failed step "success" of plugin "@semantic-release/github"');
  if (!successFailed) return false;
  return (
    /Could not resolve to an issue or pull request with the number of \d+/i.test(text) ||
    (/NOT_FOUND/.test(text) && /issue\d+/.test(text))
  );
}

export function classifyReleaseExit(code, output) {
  if (code === 0) return { code: 0, deferred: false };
  if (code === 1 && isStaleReleasePush(output)) return { code: 0, deferred: true };
  if (code === 1 && isMissingGithubIssueSuccess(output)) {
    return { code: 0, deferred: false, missingIssue: true };
  }
  return { code: code ?? 1, deferred: false };
}

export function writeDeferredOutput(deferred, env = process.env) {
  const line = `deferred=${deferred ? 'true' : 'false'}\n`;
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, line);
  }
  return line;
}

export async function publishRelease({
  spawn: spawnFn = spawn,
  command = 'npx',
  args = ['--no-install', 'semantic-release'],
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const child = spawnFn(command, args, {
    cwd,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const chunks = [];
  const forward = (stream, dest) => {
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      dest.write(chunk);
    });
  };
  if (child.stdout) forward(child.stdout, stdout);
  if (child.stderr) forward(child.stderr, stderr);

  const onSignal = (signal) => {
    child.kill(signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let finished;
  try {
    finished = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const output = Buffer.concat(chunks).toString('utf8');
  if (finished.signal) {
    return { code: null, signal: finished.signal, deferred: false, output };
  }
  return { ...classifyReleaseExit(finished.code, output), signal: null, output };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const result = await publishRelease({
    ...options,
    args: ['--no-install', 'semantic-release', ...argv],
  });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return result;
  }
  if (result.deferred) {
    console.error(DEFER_MESSAGE);
  } else if (result.missingIssue) {
    console.error(MISSING_ISSUE_MESSAGE);
  }
  writeDeferredOutput(result.deferred === true, options.env ?? process.env);
  process.exitCode = result.code;
  return result;
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await main();
