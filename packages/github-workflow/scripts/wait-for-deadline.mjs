#!/usr/bin/env node

import {
  fail,
  group,
  homeDir,
  input,
  isAlive,
  isMain,
  logTail,
  readState,
  sleep,
} from './gh-io.mjs';
import { checkWatchedProcesses, parseDuration } from './lib.mjs';

const HEARTBEAT_MS = 5 * 60_000;
const POLL_MS = 15_000;

export function resolveDeadline(state, until = input('until'), now = Date.now()) {
  if (until) {
    const asDate = Date.parse(until);
    if (Number.isFinite(asDate)) return asDate;
    return now + parseDuration(until);
  }
  if (typeof state?.deadline === 'number') return state.deadline;
  throw new Error('no deadline recorded in the state file and no `until` input given');
}

function logOfDead(state, role, pid) {
  if (role === 'leader') return state.logPath;
  return (state.followerLogs ?? [])[(state.followers ?? []).indexOf(pid)];
}

export async function main(options = {}) {
  const home = homeDir();
  const state = readState(home) ?? {};
  const watch = input('watch', { fallback: 'all' });
  if (!['leader', 'followers', 'all'].includes(watch)) {
    throw new Error(`watch must be leader|followers|all, got "${watch}"`);
  }
  const deadline = resolveDeadline(state);
  const pollMs = options.pollMs ?? POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  console.log(`[keep-alive] holding until ${new Date(deadline).toISOString()} (watch=${watch})`);
  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    const check = checkWatchedProcesses(state, options.isAlive ?? isAlive, watch);
    if (!check.ok) {
      for (const { role, pid } of check.dead) {
        group(`${role} ${pid} log (tail)`, logTail(logOfDead(state, role, pid), 80));
      }
      throw new Error(
        `${check.dead.map((d) => `${d.role} pid ${d.pid}`).join(', ')} exited before the deadline`
      );
    }
    if (Date.now() - lastBeat >= heartbeatMs) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
      console.log(`[keep-alive] alive; ${left} min remaining`);
      lastBeat = Date.now();
    }
    await sleep(Math.min(pollMs, Math.max(10, deadline - Date.now())));
  }
  console.log('[keep-alive] deadline reached');
}

/* v8 ignore start */
if (isMain(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
/* v8 ignore stop */
