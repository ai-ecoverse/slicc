import type { ConeEntry } from '@slicc/cloud-core';

export interface CapEnv {
  CONE_CAP_RUNNING: string;
  CONE_CAP_PAUSED: string;
}

export interface CapResult {
  ok: boolean;
  running: number;
  paused: number;
  runningCap: number;
  pausedCap: number;
  reason?: 'RUNNING_CAP' | 'PAUSED_CAP';
}

function parseCapLimit(name: string, raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `Invalid cap env ${name}=${JSON.stringify(raw)}: must be a non-negative integer`
    );
  }
  return n;
}

/**
 * Allow if a new running cone fits within the running cap AND total paused
 * fits within paused cap. Pass `cones` = all non-target cones for resume
 * (i.e. excluding the one transitioning).
 *
 * Counts both 'running' and 'reserved' states toward the running cap
 * (reserved entries are in-flight operations holding a slot).
 */
export function checkCapsForRun(cones: ConeEntry[], env: CapEnv): CapResult {
  const running = cones.filter((c) => c.state === 'running' || c.state === 'reserved').length;
  const paused = cones.filter((c) => c.state === 'paused').length;
  const runningCap = parseCapLimit('CONE_CAP_RUNNING', env.CONE_CAP_RUNNING);
  const pausedCap = parseCapLimit('CONE_CAP_PAUSED', env.CONE_CAP_PAUSED);
  if (running >= runningCap) {
    return { ok: false, running, paused, runningCap, pausedCap, reason: 'RUNNING_CAP' };
  }
  if (paused >= pausedCap) {
    return { ok: false, running, paused, runningCap, pausedCap, reason: 'PAUSED_CAP' };
  }
  return { ok: true, running, paused, runningCap, pausedCap };
}
