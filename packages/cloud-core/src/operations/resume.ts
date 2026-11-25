import { pairEnvEntriesToSecrets, parseEnvFilePreservingValues } from '@slicc/shared-ts';
import {
  bundleIndex,
  bundleToFiles,
  type ConeConfig,
  type ConeConfigDelta,
  type ConeConfigIndex,
  DEFAULT_CONE_MODEL,
  mergeConeConfig,
  validateConeConfig,
} from '../cone-config/index.js';
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
   * and BEFORE the leader-restart kick. Both CLI (cloud/resume.ts) and worker
   * (cloud-sessions-do.ts) pass this unconditionally now to inject a fresh IMS bearer. */
  refreshSecretsContents?: string;
  /** Optional: merge delta into existing cone-config.json + secrets.env. */
  coneConfigDelta?: ConeConfigDelta;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Skip the state check (NOT_FOUND + ALREADY_RUNNING). Used by the worker
   * after doing atomic cap-check + state-flip under DO lock. */
  skipStateCheck?: boolean;
}

// curl writes its body to /dev/null and prints the HTTP status code on stdout.
// We DO want curl to return non-zero on connection errors (so the retry loop
// can distinguish "node-server not up yet" from "200/503 response received").
// Therefore: no `|| true`; we parse status from stdout AND check exitCode.
const KICK_CMD =
  'curl -sS -X POST http://localhost:5710/api/leader-restart -o /dev/null -w "%{http_code}"';

/**
 * Merge `delta` over the existing files; returns new file contents + names index.
 * When `coneConfigJson` is null (a pre-feature cone), synthesizes a degenerate
 * base from secrets.env.
 */
export function applyConeConfigDelta(
  coneConfigJson: string | null,
  secretsEnv: string,
  delta: ConeConfigDelta
): { coneConfigJson: string; secretsEnv: string; index: ConeConfigIndex } {
  let base: ConeConfig;
  if (coneConfigJson) {
    let parsed: { model?: string; accounts?: unknown[] };
    try {
      parsed = JSON.parse(coneConfigJson) as { model?: string; accounts?: unknown[] };
    } catch (err) {
      // Distinguish a corrupt on-disk file from invalid data, so the surfaced
      // error points at the right cause instead of an opaque SyntaxError.
      throw new Error(
        `cone-config: corrupt /slicc/cone-config.json: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    base = validateConeConfig({
      model: parsed.model ?? DEFAULT_CONE_MODEL,
      accounts: parsed.accounts ?? [],
      secrets: pairEnvEntriesToSecrets(parseEnvFilePreservingValues(secretsEnv)),
    });
  } else {
    base = {
      model: DEFAULT_CONE_MODEL,
      accounts: [],
      secrets: pairEnvEntriesToSecrets(parseEnvFilePreservingValues(secretsEnv)),
    };
  }
  // Validate the MERGED result, not just the base: delta upserts arrive as
  // unknown from the worker and are otherwise unvalidated, so this is where a
  // newline-injecting secret value or bad name gets rejected before serialization.
  const merged = validateConeConfig(mergeConeConfig(base, delta));
  const files = bundleToFiles(merged);
  return { ...files, index: bundleIndex(merged) };
}

export async function resumeCone(
  deps: ResumeConeDeps,
  opts: ResumeConeOpts
): Promise<ResumeResult> {
  // skipStateCheck is used by the worker after doing atomic cap-check + state-flip
  // under DO lock. CLI still wants the NOT_FOUND + ALREADY_RUNNING checks.
  if (!opts.skipStateCheck) {
    const entry = await deps.registry.findByNameOrId(opts.query);
    if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${opts.query}`);

    // NEW: ALREADY_RUNNING check (additive — existing CLI resume didn't have this).
    // Accept both 'running' and 'reserved' as "already in flight".
    if (entry.state === 'running' || entry.state === 'reserved') {
      throw new CloudError('ALREADY_RUNNING', `cloud session is already running: ${opts.query}`);
    }
  }

  // After state checks, fetch the entry again for baseline data (the worker's
  // precheck already validated it exists).
  const entry = await deps.registry.findByNameOrId(opts.query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${opts.query}`);

  // Baseline from the registry — `startCone` stored these at create, and
  // `pauseCone` preserves them across pause. Resume requires a strictly
  // newer `updatedAt` than `entry.lastJoinUpdatedAt`, so we only declare
  // success once the kick has produced a fresh refresh.
  const baselineUpdatedAt = entry.lastJoinUpdatedAt;
  const baselineTrayId = entry.trayId;

  // Opt in to e2b's one cold-boot retry: a sandbox paused while its guest was
  // unresponsive can only come back from its disk (see ConnectOpts). It is
  // never the first attempt, and it is surfaced as `coldBooted`, not hidden.
  const handle = await deps.substrate.connect(entry.sandboxId, { rebootIfUnresponsive: true });
  const coldBooted = handle.coldBooted === true;
  if (coldBooted) {
    console.warn('[cloud-core] resume cold-booted sandbox from disk (memory snapshot unusable)', {
      sandboxId: entry.sandboxId,
    });
  }

  // Files first, so a hosted leader restarted after a cold boot reads them.
  const resumeIndex = await writeResumeConfig(handle, opts);

  // A fresh node-server loads secrets and boots the leader by itself; only a
  // leader that was already running needs the proxy reload and the kick.
  const leaderRestarted = coldBooted && (await ensureHostedLeader(handle));
  if (!leaderRestarted) await refreshRunningLeader(handle, opts);

  const refreshed = await pollForRefreshedStatus(handle, baselineUpdatedAt, {
    timeoutMs: opts.pollTimeoutMs ?? (coldBooted ? COLD_BOOT_POLL_TIMEOUT_MS : 60_000),
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
    coneConfigIndex: resumeIndex,
    ...(coldBooted ? { coldBooted: true } : {}),
  };
}

/**
 * Write the resume-time cone config: merge `coneConfigDelta` into the files on
 * disk (returns the new names index), or overwrite secrets.env with
 * `refreshSecretsContents` (the legacy path both consumers still use for a
 * fresh IMS bearer). Neither reloads the running node-server; see
 * {@link refreshRunningLeader}.
 */
async function writeResumeConfig(
  handle: SandboxHandle,
  opts: ResumeConeOpts
): Promise<ConeConfigIndex | undefined> {
  if (opts.coneConfigDelta) {
    const existingConeConfig = await readIfPresent(handle, '/slicc/cone-config.json');
    const existingSecretsEnv = (await readIfPresent(handle, '/slicc/secrets.env')) ?? '';
    const applied = applyConeConfigDelta(
      existingConeConfig,
      existingSecretsEnv,
      opts.coneConfigDelta
    );
    await handle.writeFile('/slicc/secrets.env', applied.secretsEnv);
    await handle.writeFile('/slicc/cone-config.json', applied.coneConfigJson);
    return applied.index;
  }
  if (opts.refreshSecretsContents !== undefined) {
    await handle.writeFile('/slicc/secrets.env', opts.refreshSecretsContents);
  }
  return undefined;
}

/**
 * Make an already-running node-server pick up the resume: reload the
 * fetch-proxy masking when the delta may have changed flat secrets, then kick
 * the leader to recover from a possible onReconnectGaveUp state.
 */
async function refreshRunningLeader(handle: SandboxHandle, opts: ResumeConeOpts): Promise<void> {
  // The reload must succeed before the leader Page.reload — a silent failure
  // here would leave the running cone with stale flat secrets while reporting
  // resume success.
  if (opts.coneConfigDelta) await reloadSecretsProxyUntilReady(handle);

  // The URL prefix fix (085522542) makes the kick succeed on first attempt;
  // the retry only covers the node-server cold-start window after resume.
  const kicked = await kickLeaderUntilReady(handle);
  if (!kicked) {
    throw new CloudError(
      'LEADER_NOT_READY',
      `Failed to kick leader after ${RESUME_MAX_RETRIES} retries (sandbox may not be healthy)`
    );
  }
}

// A cold boot restarts the OS, then node-server, Chromium and the leader page
// before the leader re-registers its tray, so give the freshness poll more room.
const COLD_BOOT_POLL_TIMEOUT_MS = 120_000;

// Anything answering HTTP on :5710 (even a 404) means node-server is up; curl
// fails only when nothing listens or the probe times out. The verdict goes to
// stdout and the command itself always exits 0, because e2b's commands.run
// throws CommandExitError on a non-zero exit instead of returning it.
const LEADER_PROBE_CMD =
  'curl -s -o /dev/null --max-time 5 http://localhost:5710/ && echo up || echo down';

// The template's start command. The sandbox's create-time env vars still carry
// the cone's ORIGINAL secrets/config, which start.sh would decode over the
// newer files on disk; strip them so the files written above win.
const LEADER_START_CMD =
  'env -u SLICC_SECRETS_ENV_B64 -u SLICC_CONE_CONFIG_B64 -u ADOBE_IMS_TOKEN ' +
  '-u ADOBE_IMS_TOKEN_DOMAINS /usr/local/bin/slicc-start';

/**
 * After a cold boot the hosted node-server is gone: e2b documents that a
 * reboot terminates running processes, and the template's start command "runs
 * once during template build". Start it again unless something already serves
 * :5710. Returns true when it was (re)started.
 */
async function ensureHostedLeader(handle: SandboxHandle): Promise<boolean> {
  const probe = await handle.run(LEADER_PROBE_CMD);
  if (probe.stdout.trim() === 'up') return false;
  if (!handle.spawn) {
    throw new CloudError(
      'SANDBOX_UNRESPONSIVE',
      `Sandbox ${handle.sandboxId} was cold-booted from its disk, but the ${handle.substrate} ` +
        'substrate cannot restart its hosted leader',
      { sandboxId: handle.sandboxId }
    );
  }
  await handle.spawn(LEADER_START_CMD);
  return true;
}

const RESUME_MAX_RETRIES = 5;
const RESUME_RETRY_DELAY_MS = 1000;

/**
 * Read a file if it exists; return null when the substrate reports "not found".
 * Any OTHER error (transient e2b request timeout / 5xx, socket reset, permission
 * glitch, filesystem-not-yet-ready) is rewrapped as a CloudError and re-thrown
 * so the caller aborts before running destructive downstream writes. The
 * unqualified catch this replaces silently overwrote the user's persisted
 * cone-config.json + secrets.env with a delta-applied-to-empty base whenever
 * readFile hit a transient fault (issue #1357).
 */
async function readIfPresent(handle: SandboxHandle, path: string): Promise<string | null> {
  try {
    return await handle.readFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CloudError('INTERNAL', `Failed to read ${path}: ${msg}`);
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (e.code === 'ENOENT') return true;
  if (e.name === 'NotFoundError') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /ENOENT|not found/i.test(msg);
}

async function kickLeaderUntilReady(handle: SandboxHandle): Promise<boolean> {
  for (let i = 0; i < RESUME_MAX_RETRIES; i++) {
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
    await new Promise((r) => setTimeout(r, RESUME_RETRY_DELAY_MS));
  }
  return false;
}

const RELOAD_CMD =
  'curl -sS -X POST http://localhost:5710/api/secrets/reload -o /dev/null -w "%{http_code}"';

// Reload the node-server secret proxy. Retries cover the node-server
// cold-start window after a long pause.
async function reloadSecretsProxyUntilReady(handle: SandboxHandle): Promise<void> {
  let lastError = 'no attempt made';
  for (let i = 0; i < RESUME_MAX_RETRIES; i++) {
    const result = await handle.run(RELOAD_CMD);
    if (result.exitCode === 0) {
      const status = result.stdout.trim();
      if (status === '200') return;
      if (status !== '503') {
        throw new CloudError(
          'INTERNAL',
          `/api/secrets/reload returned unexpected status ${status}`
        );
      }
      lastError = `HTTP ${status}`;
    } else {
      lastError = `curl exit ${result.exitCode}: ${result.stderr.trim()}`;
    }
    await new Promise((r) => setTimeout(r, RESUME_RETRY_DELAY_MS));
  }
  throw new CloudError(
    'INTERNAL',
    `Failed to reload secrets proxy after ${RESUME_MAX_RETRIES} retries (changed secrets may be stale; last: ${lastError})`
  );
}
