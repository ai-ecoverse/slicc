import { CloudError } from '../errors.js';
import { filterSecretsEnv } from '../secrets-filter.js';
import { pollCloudStatus } from '../polling.js';
import type { Registry } from '../registry.js';
import type { SandboxSubstrate, SandboxHandle } from '../substrate.js';
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
}

export interface StartConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
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

export async function startCone(deps: StartConeDeps, opts: StartConeOpts): Promise<StartResult> {
  const safeSecrets = filterSecretsEnv(opts.envContents);

  const handle = await deps.substrate.create({
    template: opts.template ?? 'slicc',
    autoPauseOnCap: opts.autoPauseOnCap ?? true,
    envVars: {
      SLICC_TRAY_WORKER_BASE_URL: opts.workerBaseUrl,
      ...(opts.envs ?? {}),
    },
    metadata: {
      sliccVersion: opts.sliccVersion,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.metadata ?? {}),
    },
    name: opts.name,
  });

  try {
    // Two-layer secrets bootstrap (see Plan B): start.sh prefers env-derived
    // secrets, but we still upload the full filtered file so non-Adobe secrets
    // (GitHub PATs, S3 keys, OAuth replicas) reach the sandbox.
    await handle.writeFile('/slicc/secrets.env', safeSecrets);

    let status: Awaited<ReturnType<typeof pollCloudStatus>>;
    try {
      status = await pollCloudStatus(handle, {
        timeoutMs: opts.pollTimeoutMs ?? 60_000,
        intervalMs: opts.pollIntervalMs ?? 500,
      });
    } catch (pollErr) {
      // Surface boot diagnostics before tearing down. Spec failure mode #7.
      const stderr = await tailStderr(handle, 50);
      throw new CloudError(
        'SANDBOX_NOT_READY',
        `${pollErr instanceof Error ? pollErr.message : String(pollErr)}\n` +
          `--- last 50 lines of /tmp/slicc-stderr.log ---\n${stderr}`,
        { sandboxId: handle.sandboxId }
      );
    }

    const now = new Date().toISOString();
    const entry: ConeEntry = {
      substrate: deps.substrate.id,
      sandboxId: handle.sandboxId,
      name: opts.name,
      createdAt: now,
      lastSeen: now,
      state: 'running',
      joinUrl: status.joinUrl,
      trayId: status.trayId,
      lastJoinUpdatedAt: status.updatedAt,
    };
    await deps.registry.append(entry);

    return {
      sandboxId: handle.sandboxId,
      name: opts.name,
      joinUrl: status.joinUrl,
    };
  } catch (err) {
    // Best-effort cleanup; ignore errors during teardown.
    try {
      await handle.kill();
    } catch {
      // Swallow — surfacing the start error is more useful.
    }
    throw err;
  }
}
