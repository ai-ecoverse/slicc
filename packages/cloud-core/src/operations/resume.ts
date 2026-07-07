import {
  bundleIndex,
  bundleToFiles,
  type ConeConfig,
  type ConeConfigDelta,
  type ConeConfigIndex,
  mergeConeConfig,
  type SecretEntry,
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

const DEFAULT_MODEL = 'adobe:claude-opus-4-6';

function parseSecretsEnv(text: string): SecretEntry[] {
  const domains = new Map<string, string[]>();
  for (const l of text.split('\n')) {
    const eq = l.indexOf('=');
    if (eq < 0) continue;
    const key = l.slice(0, eq);
    if (key.endsWith('_DOMAINS')) {
      domains.set(
        key.slice(0, -'_DOMAINS'.length),
        l
          .slice(eq + 1)
          .split(',')
          .filter(Boolean)
      );
    }
  }
  const out: SecretEntry[] = [];
  for (const l of text.split('\n')) {
    const eq = l.indexOf('=');
    if (eq < 0) continue;
    const name = l.slice(0, eq);
    if (name.endsWith('_DOMAINS')) continue;
    out.push({ name, value: l.slice(eq + 1), domains: domains.get(name) ?? [] });
  }
  return out;
}

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
      model: parsed.model ?? DEFAULT_MODEL,
      accounts: parsed.accounts ?? [],
      secrets: parseSecretsEnv(secretsEnv),
    });
  } else {
    base = { model: DEFAULT_MODEL, accounts: [], secrets: parseSecretsEnv(secretsEnv) };
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

  const handle = await deps.substrate.connect(entry.sandboxId);

  let resumeIndex: ConeConfigIndex | undefined;

  // New: coneConfigDelta takes precedence — read existing files, merge, write both.
  if (opts.coneConfigDelta) {
    let existingConeConfig: string | null = null;
    try {
      existingConeConfig = await handle.readFile('/slicc/cone-config.json');
    } catch {
      existingConeConfig = null;
    }
    let existingSecretsEnv = '';
    try {
      existingSecretsEnv = await handle.readFile('/slicc/secrets.env');
    } catch {
      existingSecretsEnv = '';
    }
    const applied = applyConeConfigDelta(
      existingConeConfig,
      existingSecretsEnv,
      opts.coneConfigDelta
    );
    await handle.writeFile('/slicc/secrets.env', applied.secretsEnv);
    await handle.writeFile('/slicc/cone-config.json', applied.coneConfigJson);
    // Reload the fetch-proxy masking so changed flat secrets take effect. Must
    // succeed before the leader Page.reload — a silent failure here would leave
    // the running cone with stale flat secrets while reporting resume success.
    await reloadSecretsProxyUntilReady(handle);
    resumeIndex = applied.index;
  } else if (opts.refreshSecretsContents !== undefined) {
    // Legacy path: both CLI and worker pass this now to inject a fresh IMS bearer.
    // Write to /slicc/secrets.env BEFORE the kick loop.
    await handle.writeFile('/slicc/secrets.env', opts.refreshSecretsContents);
  }

  // Kick the leader to recover from a possible onReconnectGaveUp state.
  // The URL prefix fix (085522542) makes the kick succeed on first attempt;
  // the retry only covers the node-server cold-start window after resume.
  const kicked = await kickLeaderUntilReady(handle);
  if (!kicked) {
    throw new CloudError(
      'LEADER_NOT_READY',
      `Failed to kick leader after ${RESUME_MAX_RETRIES} retries (sandbox may not be healthy)`
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
    coneConfigIndex: resumeIndex,
  };
}

const RESUME_MAX_RETRIES = 5;
const RESUME_RETRY_DELAY_MS = 1000;

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
