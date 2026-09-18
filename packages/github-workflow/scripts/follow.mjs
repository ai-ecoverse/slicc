#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliPath,
  ensureDir,
  fail,
  group,
  homeDir,
  input,
  isAlive,
  isMain,
  joinUrl,
  logTail,
  readState,
  setOutput,
  sleep,
  warning,
  writeState,
} from './gh-io.mjs';
import { buildFollowArgs, parseBoolean, parseDuration } from './lib.mjs';

export async function waitForConnect(child, logPath, timeoutMs, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  child.on('exit', (code) => {
    exited = code ?? 1;
  });
  while (Date.now() < deadline) {
    if (exited !== null) {
      group('follower log (tail)', logTail(logPath, 60));
      throw new Error(`slicc follow exited with status ${exited} before connecting`);
    }
    let log = '';
    try {
      log = readFileSync(logPath, 'utf8');
    } catch {}
    if (/\bconnected\b/i.test(log)) return true;
    await sleep(pollMs);
  }
  return false;
}

export async function main(options = {}) {
  const url = joinUrl();
  const home = ensureDir(homeDir());
  const state = readState(home) ?? { followers: [], followerLogs: [] };
  const index = (state.followers ?? []).length + 1;
  const logPath = join(home, `follower-${index}.log`);
  const args = buildFollowArgs({
    joinUrl: url,
    runner: input('runner', { fallback: 'bash -c' }),
    evalMode: parseBoolean(input('eval'), false),
    evalQuiet: input('eval-quiet'),
  });
  const connectTimeoutMs = parseDuration(input('connect-timeout', { fallback: '90s' }));

  const logFd = openSync(logPath, 'a');
  const child = spawn(cliPath(), args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
  });
  child.unref();
  console.log(`[follow] pid=${child.pid} runner="${args.slice(4).join(' ')}" log=${logPath}`);

  const connected = await waitForConnect(child, logPath, connectTimeoutMs, options.pollMs);
  if (!connected) {
    if (!isAlive(child.pid)) throw new Error('slicc follow died while connecting');
    warning('follower has not logged "connected" yet; leaving it running');
  } else {
    console.log('[follow] connected');
  }

  writeState(
    {
      ...state,
      followers: [...(state.followers ?? []), child.pid],
      followerLogs: [...(state.followerLogs ?? []), logPath],
    },
    home
  );
  setOutput('pid', child.pid);
  setOutput('log-path', logPath);
  setOutput('connected', connected);
  return { pid: child.pid, connected, logPath };
}

/* v8 ignore start */
if (isMain(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
/* v8 ignore stop */
