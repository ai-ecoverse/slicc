#!/usr/bin/env node
/**
 * Tear down everything `start-leader.mjs` / `follow.mjs` recorded: followers
 * first, then node-server (which closes its Chrome), then any Chrome left
 * holding our profile directory. Always exits 0 — this runs under
 * `if: always()` and must never mask the real failure of a job. Prints the
 * leader log tail so a failed run is diagnosable from the job page.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { group, homeDir, isAlive, logTail, readState, setOutput, terminate } from './gh-io.mjs';

function chromePidsForProfile(profileDir) {
  if (!profileDir || process.platform === 'win32') return [];
  try {
    const out = execFileSync('pgrep', ['-f', '--', `--user-data-dir=${profileDir}`], {
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

async function main() {
  const home = homeDir();
  const state = readState(home);
  if (!state) {
    console.log('[stop-leader] no state file; nothing to stop');
    return;
  }
  for (const pid of state.followers ?? []) {
    if (isAlive(pid)) {
      console.log(`[stop-leader] stopping follower pid=${pid}`);
      await terminate(pid, 5_000);
    }
  }
  if (typeof state.leader === 'number') {
    if (isAlive(state.leader)) {
      console.log(`[stop-leader] stopping node-server pid=${state.leader}`);
      await terminate(state.leader, 20_000);
    } else {
      console.log(`[stop-leader] node-server pid=${state.leader} already exited`);
    }
  }
  for (const pid of chromePidsForProfile(state.profileDir)) {
    console.log(`[stop-leader] stopping leftover chrome pid=${pid}`);
    await terminate(pid, 5_000);
  }
  if (state.logPath && existsSync(state.logPath)) {
    group('leader log (tail)', logTail(state.logPath, 120));
    setOutput('log-path', state.logPath);
  }
  (state.followerLogs ?? []).forEach((log, i) => {
    if (log && existsSync(log)) group(`follower ${i + 1} log (tail)`, logTail(log, 60));
  });
}

main().catch((err) => {
  console.log(`::warning::stop-leader: ${err instanceof Error ? err.message : String(err)}`);
});
