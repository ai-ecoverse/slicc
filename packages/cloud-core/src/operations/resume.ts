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

  refreshSecretsContents?: string;

  coneConfigDelta?: ConeConfigDelta;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;

  skipStateCheck?: boolean;
}

const KICK_CMD =
  'curl -sS -X POST http://localhost:5710/api/leader-restart -o /dev/null -w "%{http_code}"';

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

  const merged = validateConeConfig(mergeConeConfig(base, delta));
  const files = bundleToFiles(merged);
  return { ...files, index: bundleIndex(merged) };
}

export async function resumeCone(
  deps: ResumeConeDeps,
  opts: ResumeConeOpts
): Promise<ResumeResult> {
  if (!opts.skipStateCheck) {
    const entry = await deps.registry.findByNameOrId(opts.query);
    if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${opts.query}`);

    if (entry.state === 'running' || entry.state === 'reserved') {
      throw new CloudError('ALREADY_RUNNING', `cloud session is already running: ${opts.query}`);
    }
  }

  const entry = await deps.registry.findByNameOrId(opts.query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${opts.query}`);

  const baselineUpdatedAt = entry.lastJoinUpdatedAt;
  const baselineTrayId = entry.trayId;

  const handle = await deps.substrate.connect(entry.sandboxId);

  let resumeIndex: ConeConfigIndex | undefined;

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

    await reloadSecretsProxyUntilReady(handle);
    resumeIndex = applied.index;
  } else if (opts.refreshSecretsContents !== undefined) {
    await handle.writeFile('/slicc/secrets.env', opts.refreshSecretsContents);
  }

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

  const trayRebuilt = Boolean(
    baselineTrayId && refreshed.trayId && baselineTrayId !== refreshed.trayId
  );
  const versionMismatch =
    refreshed.sliccVersion && refreshed.sliccVersion !== opts.localSliccVersion
      ? { running: refreshed.sliccVersion, local: opts.localSliccVersion }
      : undefined;

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
