import { promises as fs } from 'node:fs';
import type { ConeEntry, StartResult, CloudStatus } from '@slicc/cloud-core';
import { CloudError, filterSecretsEnv, pollCloudStatus } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';
import type { SandboxHandle, SandboxSubstrate } from './substrate.js';

export interface RunStartOpts {
  substrate: SandboxSubstrate;
  envFilePath: string;
  registryPath: string;
  workerBaseUrl: string;
  sliccVersion: string;
  template?: string;
  name?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Test-only hook: invoked after substrate.create returns. */
  onAfterCreate?: (handle: SandboxHandle) => Promise<void>;
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

export async function runStart(opts: RunStartOpts): Promise<StartResult> {
  const rawEnv = await fs.readFile(opts.envFilePath, 'utf-8');
  const envContents = filterSecretsEnv(rawEnv);

  const handle = await opts.substrate.create({
    template: opts.template ?? 'slicc',
    autoPauseOnCap: true,
    envVars: {
      SLICC_TRAY_WORKER_BASE_URL: opts.workerBaseUrl,
    },
    metadata: {
      sliccVersion: opts.sliccVersion,
      createdBy: process.env['USER'] ?? 'unknown',
      ...(opts.name ? { name: opts.name } : {}),
    },
    name: opts.name,
  });

  try {
    await handle.writeFile('/slicc/secrets.env', envContents);

    if (opts.onAfterCreate) await opts.onAfterCreate(handle);

    let status: CloudStatus;
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

    const reg = new FileRegistry(opts.registryPath);
    const nowIso = new Date().toISOString();
    const entry: ConeEntry = {
      substrate: opts.substrate.id,
      sandboxId: handle.sandboxId,
      name: opts.name,
      createdAt: nowIso,
      joinUrl: status.joinUrl,
      lastSeen: nowIso,
      state: 'running',
      // These two are the comparison baseline for runResume. Set them at
      // start so resume can detect (a) a stale read after the kick (via
      // updatedAt strictly newer than this) and (b) a tray rebuild (via
      // trayId mismatch).
      trayId: status.trayId,
      lastJoinUpdatedAt: status.updatedAt,
    };
    await reg.append(entry);

    return { sandboxId: handle.sandboxId, joinUrl: status.joinUrl, name: opts.name };
  } catch (err) {
    // Best-effort cleanup; ignore errors during teardown.
    try {
      await handle.kill();
    } catch (cleanupErr) {
      console.warn(
        'failed to clean up partial sandbox after start error',
        handle.sandboxId,
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      );
    }
    throw err;
  }
}
