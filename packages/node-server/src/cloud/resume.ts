import { CloudSessionRegistry } from './registry.js';
import type { SandboxHandle, SandboxSubstrate } from './substrate.js';

export interface RunResumeOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
  localSliccVersion: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface ResumeResult {
  sandboxId: string;
  joinUrl: string;
  trayRebuilt: boolean;
  versionMismatch?: { running: string; local: string };
}

// curl writes its body to /dev/null and prints the HTTP status code on stdout.
// We DO want curl to return non-zero on connection errors (so the retry loop
// can distinguish "node-server not up yet" from "200/503 response received").
// Therefore: no `|| true`; we parse status from stdout AND check exitCode.
const KICK_CMD =
  'curl -sS -X POST http://localhost:5710/api/leader-restart -o /dev/null -w "%{http_code}"';

export async function runResume(opts: RunResumeOpts): Promise<ResumeResult> {
  const reg = new CloudSessionRegistry(opts.registryPath);
  const entry = await reg.findByNameOrId(opts.query);
  if (!entry) throw new Error(`cloud session not found: ${opts.query}`);

  // Baseline from the registry — `runStart` stored these at create, and
  // `runPause` preserves them across pause. Resume requires a strictly
  // newer `updatedAt` than `entry.lastJoinUpdatedAt`, so we only declare
  // success once the kick has produced a fresh refresh.
  const baselineUpdatedAt = entry.lastJoinUpdatedAt;
  const baselineTrayId = entry.trayId;

  const handle = await opts.substrate.connect(entry.sandboxId);

  // Kick the leader to recover from a possible onReconnectGaveUp state.
  // 5×1s retry covers the CDP-cold-start race after a long pause.
  // Success = curl exited 0 AND status is 200. 503 means the SLICC page
  // target isn't ready yet — retry. Any other status is a hard error.
  let kicked = false;
  for (let i = 0; i < 5; i++) {
    const result = await handle.run(KICK_CMD);
    if (result.exitCode === 0) {
      const status = result.stdout.trim();
      if (status === '200') {
        kicked = true;
        break;
      }
      if (status !== '503') {
        throw new Error(`/api/leader-restart returned unexpected status ${status}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!kicked) {
    throw new Error('Failed to kick leader after 5 retries (sandbox may not be healthy)');
  }

  const refreshed = await pollForRefreshedStatus(handle, baselineUpdatedAt, {
    timeoutMs: opts.pollTimeoutMs ?? 60_000,
    intervalMs: opts.pollIntervalMs ?? 500,
  });

  // Tray rebuilt iff we had a baseline AND the new trayId is different.
  // (No baseline → can't tell, default to false so we don't spuriously
  // warn on a freshly-created sandbox where the registry was wiped.)
  const trayRebuilt = Boolean(
    baselineTrayId && refreshed.trayId && baselineTrayId !== refreshed.trayId
  );
  const versionMismatch =
    refreshed.sliccVersion && refreshed.sliccVersion !== opts.localSliccVersion
      ? { running: refreshed.sliccVersion, local: opts.localSliccVersion }
      : undefined;

  // Write the new baseline back — same fields runStart populated.
  await reg.update(entry.sandboxId, {
    joinUrl: refreshed.joinUrl,
    lastSeen: new Date().toISOString(),
    state: 'running',
    trayId: refreshed.trayId,
    lastJoinUpdatedAt: refreshed.updatedAt,
  });

  return {
    sandboxId: entry.sandboxId,
    joinUrl: refreshed.joinUrl,
    trayRebuilt,
    ...(versionMismatch ? { versionMismatch } : {}),
  };
}

interface CloudStatus {
  joinUrl: string;
  trayId?: string;
  sliccVersion?: string;
  updatedAt?: string;
}

async function pollForRefreshedStatus(
  handle: SandboxHandle,
  baselineUpdatedAt: string | undefined,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<CloudStatus> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatus;
      if (parsed.joinUrl) {
        // Require a STRICTLY newer updatedAt than the registry baseline.
        // If we have no baseline (first-time resume of an externally-created
        // sandbox), accept any well-formed read.
        if (!baselineUpdatedAt) return parsed;
        if (parsed.updatedAt && parsed.updatedAt !== baselineUpdatedAt) {
          return parsed;
        }
      }
    } catch {
      /* file not yet present or not yet refreshed */
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`cloud-status did not refresh within ${opts.timeoutMs}ms`);
}
