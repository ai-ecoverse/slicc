import { CloudError } from '../errors.js';
import { pollForRefreshedStatus } from '../polling.js';
import type { Registry } from '../registry.js';
import type { SandboxHandle, SandboxSubstrate } from '../substrate.js';
import type { ResumeResult } from '../types.js';

export interface ResumeConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export interface ResumeConeOpts {
  query: string;
  localSliccVersion: string;
  /** Optional: if provided, written to /slicc/secrets.env AFTER substrate.connect
   * and BEFORE the leader-restart kick. Used by Plan D's worker to inject a
   * fresh IMS bearer. CLI currently leaves this undefined; Plan B can pass it
   * for the same effect. */
  refreshSecretsContents?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

// curl writes its body to /dev/null and prints the HTTP status code on stdout.
// We DO want curl to return non-zero on connection errors (so the retry loop
// can distinguish "node-server not up yet" from "200/503 response received").
// Therefore: no `|| true`; we parse status from stdout AND check exitCode.
const KICK_CMD =
  'curl -sS -X POST http://localhost:5710/api/leader-restart -o /dev/null -w "%{http_code}"';

export async function resumeCone(
  deps: ResumeConeDeps,
  opts: ResumeConeOpts
): Promise<ResumeResult> {
  const entry = await deps.registry.findByNameOrId(opts.query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${opts.query}`);

  // NEW: ALREADY_RUNNING check (additive — existing CLI resume didn't have this).
  if (entry.state === 'running') {
    throw new CloudError('ALREADY_RUNNING', `cloud session is already running: ${opts.query}`);
  }

  // Baseline from the registry — `startCone` stored these at create, and
  // `pauseCone` preserves them across pause. Resume requires a strictly
  // newer `updatedAt` than `entry.lastJoinUpdatedAt`, so we only declare
  // success once the kick has produced a fresh refresh.
  const baselineUpdatedAt = entry.lastJoinUpdatedAt;
  const baselineTrayId = entry.trayId;

  const handle = await deps.substrate.connect(entry.sandboxId);

  // NEW: refreshSecretsContents hook. If provided, write to /slicc/secrets.env
  // BEFORE the kick loop. This is additive — CLI passes undefined; Plan D's
  // worker will pass a fresh IMS bearer token.
  if (opts.refreshSecretsContents !== undefined) {
    await handle.writeFile('/slicc/secrets.env', opts.refreshSecretsContents);
  }

  // Kick the leader to recover from a possible onReconnectGaveUp state.
  // 5×1s retry covers the CDP-cold-start race after a long pause.
  // Success = curl exited 0 AND status is 200. 503 means the SLICC page
  // target isn't ready yet — retry. Any other status is a hard error.
  const kicked = await kickLeaderUntilReady(handle);
  if (!kicked) {
    throw new CloudError(
      'LEADER_NOT_READY',
      'Failed to kick leader after 5 retries (sandbox may not be healthy)'
    );
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

  // Write the new baseline back — same fields startCone populated.
  await deps.registry.update(entry.sandboxId, {
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

async function kickLeaderUntilReady(handle: SandboxHandle): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    const result = await handle.run(KICK_CMD);
    if (result.exitCode === 0) {
      const status = result.stdout.trim();
      if (status === '200') return true;
      if (status !== '503') {
        throw new CloudError(
          'LEADER_NOT_READY',
          `/api/leader-restart returned unexpected status ${status}`
        );
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
