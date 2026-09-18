#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  group,
  homeDir,
  isAlive,
  isMain,
  logTail,
  readState,
  setOutput,
  terminate,
  warning,
} from './gh-io.mjs';
import { removeCredentialFiles } from './start-leader.mjs';

export function chromePidsForProfile(profileDir, exec = execFileSync) {
  if (!profileDir || process.platform === 'win32') return [];
  try {
    const out = exec('pgrep', ['-f', '--', `--user-data-dir=${profileDir}`], {
      encoding: 'utf8',
    });
    return out
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

export async function main(options = {}) {
  const home = homeDir();
  const state = readState(home);
  if (!state) {
    console.log('[stop-leader] no state file; nothing to stop');
    return;
  }
  const grace = options.graceMs ?? 20_000;
  for (const pid of state.followers ?? []) {
    if (isAlive(pid)) {
      console.log(`[stop-leader] stopping follower pid=${pid}`);
      await terminate(pid, Math.min(grace, 5_000));
    }
  }
  if (typeof state.leader === 'number') {
    if (isAlive(state.leader)) {
      console.log(`[stop-leader] stopping node-server pid=${state.leader}`);
      await terminate(state.leader, grace);
    } else {
      console.log(`[stop-leader] node-server pid=${state.leader} already exited`);
    }
  }
  removeCredentialFiles(state.secretsFile);
  console.log('[stop-leader] credential files removed');
  for (const pid of chromePidsForProfile(state.profileDir, options.exec)) {
    console.log(`[stop-leader] stopping leftover chrome pid=${pid}`);
    await terminate(pid, Math.min(grace, 5_000));
  }
  if (state.logPath && existsSync(state.logPath)) {
    group('leader log (tail)', logTail(state.logPath, 120));
    setOutput('log-path', state.logPath);
  }
  (state.followerLogs ?? []).forEach((log, i) => {
    if (log && existsSync(log)) group(`follower ${i + 1} log (tail)`, logTail(log, 60));
  });
}

/* v8 ignore start */
if (isMain(import.meta.url)) {
  main().catch((err) =>
    warning(`stop-leader: ${err instanceof Error ? err.message : String(err)}`)
  );
}
/* v8 ignore stop */
