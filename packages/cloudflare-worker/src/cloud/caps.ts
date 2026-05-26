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

/**
 * Allow if a new running cone fits within the running cap AND total paused
 * fits within paused cap. Pass `cones` = all non-target cones for resume
 * (i.e. excluding the one transitioning).
 */
export function checkCapsForRun(cones: ConeEntry[], env: CapEnv): CapResult {
  const running = cones.filter((c) => c.state === 'running').length;
  const paused = cones.filter((c) => c.state === 'paused').length;
  const runningCap = Number.parseInt(env.CONE_CAP_RUNNING, 10);
  const pausedCap = Number.parseInt(env.CONE_CAP_PAUSED, 10);
  if (running >= runningCap) {
    return { ok: false, running, paused, runningCap, pausedCap, reason: 'RUNNING_CAP' };
  }
  if (paused >= pausedCap) {
    return { ok: false, running, paused, runningCap, pausedCap, reason: 'PAUSED_CAP' };
  }
  return { ok: true, running, paused, runningCap, pausedCap };
}
