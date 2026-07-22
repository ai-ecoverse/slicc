import { encodeBundleEnv } from '../cone-config/index.js';
import { CloudError } from '../errors.js';
import { pollCloudStatus } from '../polling.js';
import type { Registry } from '../registry.js';
import { filterSecretsEnv } from '../secrets-filter.js';
import type { SandboxHandle, SandboxSubstrate } from '../substrate.js';
import type { ConeEntry, StartResult } from '../types.js';

export interface StartConeOpts {
  /** Full secrets.env content (caller reads from disk in CLI; constructs in
   * worker). Will be filtered with filterSecretsEnv before upload. */
  envContents: string;
  /** Tray worker base URL injected into the sandbox env. */
  workerBaseUrl: string;
  /** Substrate template ID (default 'slicc'). */
  template?: string;
  /** Optional user-supplied name; goes into substrate.metadata.name. */
  name?: string;
  /** SLICC version recorded on the registry entry. */
  sliccVersion: string;
  /** Additional metadata tagged on the sandbox (e.g., { userId, email } in
   * worker context). Merged on top of the sandbox metadata. */
  metadata?: Record<string, string>;
  /** Extra envs passed at substrate.create. start.sh writes /slicc/secrets.env
   * from these BEFORE node-server boots (no race). Plan B task. */
  envs?: Record<string, string>;
  /** Poll budget for waiting on /tmp/slicc-join.json. */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Default true. */
  autoPauseOnCap?: boolean;
  /** Optional reservation ID from reserveConeStart(); if provided, updates
   * that placeholder entry instead of appending a new one. */
  reservationId?: string;
  /** Optional cone config JSON; injected as SLICC_CONE_CONFIG_B64 env and
   * written to /slicc/cone-config.json after create. */
  coneConfigJson?: string;
}

export interface StartConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export interface ReserveConeStartOpts {
  /** User ID for filtering (worker use) or undefined (CLI use). */
  userId?: string;
  /** Optional name; checked for conflicts. */
  name?: string;
  /** Metadata to store on the reservation entry. */
  metadata?: Record<string, string>;
  /** Pre-reconciled cone list (from listCones). If provided, skips the slow
   * reconciliation call inside reserveConeStart, making it fast enough to fit
   * under blockConcurrencyWhile. Worker callers MUST pass this to avoid
   * holding the DO lock through substrate.list(). */
  reconciledCones?: ConeEntry[];
}

/** Fetch the last n lines of /tmp/slicc-stderr.log from inside the sandbox. */
async function tailStderr(handle: SandboxHandle, n: number): Promise<string> {
  try {
    const raw = await handle.readFile('/tmp/slicc-stderr.log');
    const lines = raw.split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  } catch (err) {
    // Discriminate "file absent" (acceptable fallback) from other errors
    // (substrate read failure — worth surfacing for debug).
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(msg)) {
      return '(no /tmp/slicc-stderr.log produced)';
    }
    return `(failed to read /tmp/slicc-stderr.log: ${msg})`;
  }
}

/**
 * Reserve an in-flight start in the registry atomically under a DO lock before
 * substrate.create. Throws CloudError('NAME_TAKEN') on a live-name conflict.
 *
 * Callers MUST wrap this in blockConcurrencyWhile so concurrent calls observe
 * each other's reservations.
 */
export async function reserveConeStart(
  deps: StartConeDeps,
  opts: ReserveConeStartOpts
): Promise<{ reservationId: string }> {
  const reservationId = `pending-${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  // Read existing entries to enforce name conflicts.
  // If caller provided a pre-reconciled list (worker DO path), use it directly.
  // Otherwise (CLI path), do a full reconciliation via listCones.
  let existing: ConeEntry[];
  if (opts.reconciledCones) {
    existing = opts.reconciledCones;
  } else {
    const { listCones } = await import('./list.js');
    existing = await listCones(deps, opts.userId ? { metadata: { userId: opts.userId } } : {});
  }

  // Name conflict check
  const requestedName = opts.name?.trim();
  if (requestedName && existing.some((e) => e.state !== 'dead' && e.name === requestedName)) {
    throw new CloudError('NAME_TAKEN', `cloud session name already exists: ${requestedName}`);
  }

  // Append placeholder entry with 'reserved' state
  const reservation: ConeEntry = {
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
  await deps.registry.append(reservation);

  return { reservationId };
}

// Update or append the sandbox's registry placeholder depending on whether
// we have a reservation. If reservationId is provided, swap it for the real
// sandboxId; otherwise append a new placeholder as before.
//
// The placeholder ensures concurrent /list-cones calls see the cone in the
// registry (pass 1) instead of treating it as an orphan (pass 2). The empty
// joinUrl means the dashboard hides the Open button until pollCloudStatus
// completes and the entry is updated below. State is 'reserved' until poll
// completes. Returns the (possibly swapped) active registry key.
async function persistSandboxPlaceholder(
  deps: StartConeDeps,
  opts: StartConeOpts,
  handle: SandboxHandle,
  createdAt: string
): Promise<string> {
  if (opts.reservationId) {
    // Remove the reservation entry and append the real one
    await deps.registry.remove(opts.reservationId);
    const placeholder: ConeEntry = {
      substrate: deps.substrate.id,
      sandboxId: handle.sandboxId,
      name: opts.name,
      createdAt,
      lastSeen: createdAt,
      state: 'reserved',
      joinUrl: '',
      metadata: opts.metadata,
    };
    await deps.registry.append(placeholder);
  } else {
    // Legacy path: no reservation, append directly
    const placeholder: ConeEntry = {
      substrate: deps.substrate.id,
      sandboxId: handle.sandboxId,
      name: opts.name,
      createdAt,
      lastSeen: createdAt,
      state: 'reserved',
      joinUrl: '',
    };
    await deps.registry.append(placeholder);
  }
  return handle.sandboxId;
}

// Poll /tmp/slicc-join.json until the leader is ready, surfacing boot
// diagnostics (tail of /tmp/slicc-stderr.log) in the thrown error on timeout.
// Spec failure mode #7.
async function pollUntilReady(
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
      `${pollErr instanceof Error ? pollErr.message : String(pollErr)}\n` +
        `--- last 50 lines of /tmp/slicc-stderr.log ---\n${stderr}`,
      { sandboxId: handle.sandboxId }
    );
  }
}

// Best-effort cleanup after a failed start: remove whichever registry entry
// is currently active, and kill the real sandbox if one was created. Both
// steps are independently best-effort — failures are logged, not rethrown,
// so the original error always propagates to the caller.
async function cleanupFailedStart(
  deps: StartConeDeps,
  activeRegistryId: string | undefined,
  handle: SandboxHandle | undefined
): Promise<void> {
  if (activeRegistryId) {
    try {
      await deps.registry.remove(activeRegistryId);
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn('[cloud-core] start cleanup', {
        phase: 'registry-remove',
        sandboxId: activeRegistryId,
        err: msg,
      });
    }
  }
  // Always kill the real sandbox if it was created (handle exists at this point)
  if (handle) {
    try {
      await handle.kill();
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn('[cloud-core] start cleanup', {
        phase: 'handle-kill',
        sandboxId: handle.sandboxId,
        err: msg,
      });
    }
  }
}

export async function startCone(deps: StartConeDeps, opts: StartConeOpts): Promise<StartResult> {
  const safeSecrets = filterSecretsEnv(opts.envContents);

  // Track whichever registry entry is currently live, for cleanup on failure.
  let activeRegistryId: string | undefined = opts.reservationId;
  let handle: SandboxHandle | undefined;

  try {
    // Wrap create inside try block to ensure reservation cleanup on failure.
    handle = await deps.substrate.create({
      template: opts.template ?? 'slicc',
      autoPauseOnCap: opts.autoPauseOnCap ?? true,
      envVars: {
        SLICC_TRAY_WORKER_BASE_URL: opts.workerBaseUrl,
        SLICC_SECRETS_ENV_B64: encodeBundleEnv(safeSecrets),
        ...(opts.coneConfigJson
          ? { SLICC_CONE_CONFIG_B64: encodeBundleEnv(opts.coneConfigJson) }
          : {}),
        ...(opts.envs ?? {}),
      },
      metadata: {
        sliccVersion: opts.sliccVersion,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.metadata ?? {}),
      },
      name: opts.name,
    });

    // Capture freshness baseline AFTER sandbox creation: any /tmp/slicc-join.json
    // with updatedAt at or before this ISO is from the template snapshot, not
    // the new sandbox's leader. Subtract a small skew margin for clock drift
    // between the worker fetching this timestamp and the sandbox writing the
    // file: the sandbox's clock might be slightly behind, so a tiny margin
    // gives the leader's first real write a chance to be accepted.
    const minUpdatedAt = new Date(Date.now() - 5_000).toISOString();
    const createdAt = new Date().toISOString();

    activeRegistryId = await persistSandboxPlaceholder(deps, opts, handle, createdAt);

    // Two-layer secrets bootstrap (see Plan B):
    //   1. start.sh writes /slicc/secrets.env from $ADOBE_IMS_TOKEN if the file
    //      doesn't already exist (fallback for race-free worker path where env-vars
    //      arrive before this writeFile lands).
    //   2. THIS writeFile uploads the full filtered secrets.env. Worker overwrites
    //      with Adobe-only content (effectively a no-op since start.sh already wrote
    //      the same token). CLI overwrites with non-Adobe secrets (GitHub PATs, S3
    //      keys, etc.), load-bearing for CLI-launched cones. The CLI race is benign
    //      because the page-side bootstrap polls /api/hosted-bootstrap after a 5s
    //      delay, by which time this writeFile has landed.
    await handle.writeFile('/slicc/secrets.env', safeSecrets);
    if (opts.coneConfigJson) {
      await handle.writeFile('/slicc/cone-config.json', opts.coneConfigJson);
    }

    const status = await pollUntilReady(handle, opts, minUpdatedAt);

    // Promote the placeholder to a fully-populated running entry.
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
    await cleanupFailedStart(deps, activeRegistryId, handle);
    throw err;
  }
}
