#!/usr/bin/env node
/**
 * Keep the job alive until the leader's deadline, failing fast if a watched
 * process dies. This is the "keep it running for N minutes" step: the leader
 * and any followers are detached children, so without this the job would
 * simply end and the runner would reap them.
 *
 * Inputs: INPUT_WATCH (`leader` | `followers` | `all`, default `all`),
 * INPUT_UNTIL (optional ISO timestamp or duration overriding the recorded
 * deadline — a follower-only job has no leader deadline to read).
 */
import { fail, group, homeDir, input, isAlive, logTail, readState, sleep } from './gh-io.mjs';
import { checkWatchedProcesses, parseDuration } from './lib.mjs';

const HEARTBEAT_MS = 5 * 60_000;
const POLL_MS = 15_000;

function resolveDeadline(state) {
  const until = input('until');
  if (until) {
    const asDate = Date.parse(until);
    if (Number.isFinite(asDate)) return asDate;
    return Date.now() + parseDuration(until);
  }
  if (typeof state?.deadline === 'number') return state.deadline;
  throw new Error('no deadline recorded in the state file and no `until` input given');
}

async function main() {
  const home = homeDir();
  const state = readState(home) ?? {};
  const watch = input('watch', { fallback: 'all' });
  if (!['leader', 'followers', 'all'].includes(watch)) {
    throw new Error(`watch must be leader|followers|all, got "${watch}"`);
  }
  const deadline = resolveDeadline(state);
  console.log(`[keep-alive] holding until ${new Date(deadline).toISOString()} (watch=${watch})`);
  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    const check = checkWatchedProcesses(state, isAlive, watch);
    if (!check.ok) {
      for (const { role, pid } of check.dead) {
        const log =
          role === 'leader'
            ? state.logPath
            : (state.followerLogs ?? [])[(state.followers ?? []).indexOf(pid)];
        group(`${role} ${pid} log (tail)`, logTail(log, 80));
      }
      throw new Error(
        `${check.dead.map((d) => `${d.role} pid ${d.pid}`).join(', ')} exited before the deadline`
      );
    }
    if (Date.now() - lastBeat >= HEARTBEAT_MS) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
      console.log(`[keep-alive] alive; ${left} min remaining`);
      lastBeat = Date.now();
    }
    await sleep(Math.min(POLL_MS, Math.max(250, deadline - Date.now())));
  }
  console.log('[keep-alive] deadline reached');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
