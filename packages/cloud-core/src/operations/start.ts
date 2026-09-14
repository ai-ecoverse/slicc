import { encodeBundleEnv } from '../cone-config/index.js';
import { CloudError } from '../errors.js';
import { pollCloudStatus } from '../polling.js';
import type { Registry } from '../registry.js';
import { filterSecretsEnv } from '../secrets-filter.js';
import type { SandboxHandle, SandboxSubstrate } from '../substrate.js';
import type { ConeEntry, StartResult } from '../types.js';

export interface StartConeOpts {
  envContents: string;

  workerBaseUrl: string;

  template?: string;

  name?: string;

  sliccVersion: string;

  metadata?: Record<string, string>;

  envs?: Record<string, string>;

  pollTimeoutMs?: number;
  pollIntervalMs?: number;

  autoPauseOnCap?: boolean;

  reservationId?: string;

  coneConfigJson?: string;
}

export interface StartConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export interface ReserveSlotOpts {
  userId?: string;

  name?: string;

  metadata?: Record<string, string>;

  sliccVersion: string;

  env?: {
    CONE_CAP_RUNNING: string;
    CONE_CAP_PAUSED: string;
  };

  reconciledCones?: ConeEntry[];
}

async function tailStderr(handle: SandboxHandle, n: number): Promise<string> {
  try {
    const raw = await handle.readFile('/tmp/slicc-stderr.log');
    const lines = raw.split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(msg)) {
      return '(no /tmp/slicc-stderr.log produced)';
    }
    return `(failed to read /tmp/slicc-stderr.log: ${msg})`;
  }
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function enforceCaps(existing: ConeEntry[], env: NonNullable<ReserveSlotOpts['env']>): void {
  const running = existing.filter((e) => e.state === 'running' || e.state === 'reserved').length;
  const paused = existing.filter((e) => e.state === 'paused').length;
  const runningCap = parseCapLimit('CONE_CAP_RUNNING', env.CONE_CAP_RUNNING);
  const pausedCap = parseCapLimit('CONE_CAP_PAUSED', env.CONE_CAP_PAUSED);
  if (running >= runningCap) {
    throw new CloudError('CAP_EXCEEDED', `at running cap (${running}/${runningCap})`, {
      running,
      cap: runningCap,
    });
  }
  if (paused >= pausedCap) {
    throw new CloudError('CAP_EXCEEDED', `at paused cap (${paused}/${pausedCap})`, {
      paused,
      cap: pausedCap,
    });
  }
}

async function loadExistingCones(deps: StartConeDeps, opts: ReserveSlotOpts): Promise<ConeEntry[]> {
  if (opts.reconciledCones) return opts.reconciledCones;
  const { listCones } = await import('./list.js');
  return listCones(deps, opts.userId ? { metadata: { userId: opts.userId } } : {});
}

export async function reserveSlot(
  deps: StartConeDeps,
  opts: ReserveSlotOpts
): Promise<{ reservationId: string }> {
  const reservationId = `pending-${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  const existing = await loadExistingCones(deps, opts);

  if (opts.env) {
    enforceCaps(existing, opts.env);
  }

  const requestedName = opts.name?.trim();
  if (requestedName && existing.some((e) => e.state !== 'dead' && e.name === requestedName)) {
    throw new CloudError('NAME_TAKEN', `cloud session name already exists: ${requestedName}`);
  }

  const placeholder: ConeEntry = {
    substrate: deps.substrate.id,
    sandboxId: reservationId,
    name: requestedName,
    createdAt,
    lastSeen: createdAt,
    state: 'reserved',
    reservedAt: createdAt,
    joinUrl: '',
    metadata: opts.metadata,
  };
  await deps.registry.append(placeholder);

  return { reservationId };
}

function buildCreateEnvVars(opts: StartConeOpts, safeSecrets: string): Record<string, string> {
  return {
    SLICC_TRAY_WORKER_BASE_URL: opts.workerBaseUrl,
    SLICC_SECRETS_ENV_B64: encodeBundleEnv(safeSecrets),
    ...(opts.coneConfigJson ? { SLICC_CONE_CONFIG_B64: encodeBundleEnv(opts.coneConfigJson) } : {}),
    ...(opts.envs ?? {}),
  };
}

function buildCreateMetadata(opts: StartConeOpts): Record<string, string> {
  return {
    sliccVersion: opts.sliccVersion,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.metadata ?? {}),
  };
}

async function registerStartPlaceholder(
  registry: Registry,
  substrateId: string,
  handle: SandboxHandle,
  opts: StartConeOpts,
  createdAt: string
): Promise<string> {
  if (opts.reservationId) {
    await registry.remove(opts.reservationId);
    const placeholder: ConeEntry = {
      substrate: substrateId,
      sandboxId: handle.sandboxId,
      name: opts.name,
      createdAt,
      lastSeen: createdAt,
      state: 'reserved',
      joinUrl: '',
      metadata: opts.metadata,
    };
    await registry.append(placeholder);
  } else {
    const placeholder: ConeEntry = {
      substrate: substrateId,
      sandboxId: handle.sandboxId,
      name: opts.name,
      createdAt,
      lastSeen: createdAt,
      state: 'reserved',
      joinUrl: '',
    };
    await registry.append(placeholder);
  }
  return handle.sandboxId;
}

async function writeBootstrapFiles(
  handle: SandboxHandle,
  safeSecrets: string,
  coneConfigJson: string | undefined
): Promise<void> {
  await handle.writeFile('/slicc/secrets.env', safeSecrets);
  if (coneConfigJson) {
    await handle.writeFile('/slicc/cone-config.json', coneConfigJson);
  }
}

async function pollStatusOrThrow(
  handle: SandboxHandle,
  opts: StartConeOpts,
  minUpdatedAt: string
): Promise<Awaited<ReturnType<typeof pollCloudStatus>>> {
  try {
    return await pollCloudStatus(handle, {
      timeoutMs: opts.pollTimeoutMs ?? 60_000,
      intervalMs: opts.pollIntervalMs ?? 500,
      minUpdatedAt,
    });
  } catch (pollErr) {
    const stderr = await tailStderr(handle, 50);
    throw new CloudError(
      'SANDBOX_NOT_READY',
      `${errMessage(pollErr)}\n` + `--- last 50 lines of /tmp/slicc-stderr.log ---\n${stderr}`,
      { sandboxId: handle.sandboxId }
    );
  }
}

async function bestEffortCleanup(
  registry: Registry,
  activeRegistryId: string | undefined,
  handle: SandboxHandle | undefined
): Promise<void> {
  if (activeRegistryId) {
    try {
      await registry.remove(activeRegistryId);
    } catch (cleanupErr) {
      console.warn('[cloud-core] start cleanup', {
        phase: 'registry-remove',
        sandboxId: activeRegistryId,
        err: errMessage(cleanupErr),
      });
    }
  }

  if (handle) {
    try {
      await handle.kill();
    } catch (cleanupErr) {
      console.warn('[cloud-core] start cleanup', {
        phase: 'handle-kill',
        sandboxId: handle.sandboxId,
        err: errMessage(cleanupErr),
      });
    }
  }
}

export async function startCone(deps: StartConeDeps, opts: StartConeOpts): Promise<StartResult> {
  const safeSecrets = filterSecretsEnv(opts.envContents);

  let activeRegistryId: string | undefined = opts.reservationId;
  let handle: SandboxHandle | undefined;

  try {
    handle = await deps.substrate.create({
      template: opts.template ?? 'slicc',
      autoPauseOnCap: opts.autoPauseOnCap ?? true,
      envVars: buildCreateEnvVars(opts, safeSecrets),
      metadata: buildCreateMetadata(opts),
      name: opts.name,
    });

    const minUpdatedAt = new Date(Date.now() - 5_000).toISOString();
    const createdAt = new Date().toISOString();

    activeRegistryId = await registerStartPlaceholder(
      deps.registry,
      deps.substrate.id,
      handle,
      opts,
      createdAt
    );

    await writeBootstrapFiles(handle, safeSecrets, opts.coneConfigJson);

    const status = await pollStatusOrThrow(handle, opts, minUpdatedAt);

    await deps.registry.update(handle.sandboxId, {
      state: 'running',
      joinUrl: status.joinUrl,
      trayId: status.trayId,
      lastJoinUpdatedAt: status.updatedAt,
      lastSeen: new Date().toISOString(),
    });

    return {
      sandboxId: handle.sandboxId,
      name: opts.name,
      joinUrl: status.joinUrl,
    };
  } catch (err) {
    await bestEffortCleanup(deps.registry, activeRegistryId, handle);
    throw err;
  }
}
