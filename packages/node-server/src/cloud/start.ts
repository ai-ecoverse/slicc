import { promises as fs } from 'node:fs';
import { CloudSessionRegistry, type CloudSessionEntry } from './registry.js';
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

export interface StartResult {
  sandboxId: string;
  joinUrl: string;
  name?: string;
}

/**
 * Strip locally-only keys from secrets.env before upload. E2B_API_KEY is the
 * user's substrate credential — there is no reason for it to live inside the
 * cloud sandbox where the cone could use it to spawn additional sandboxes
 * against the user's e2b account. Keep this list narrow.
 */
const SECRETS_STRIP_KEYS = ['E2B_API_KEY', 'E2B_API_KEY_DOMAINS'] as const;

export function filterSecretsEnv(contents: string): string {
  const out: string[] = [];
  for (const line of contents.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && (SECRETS_STRIP_KEYS as readonly string[]).includes(m[1])) continue;
    out.push(line);
  }
  return out.join('\n');
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

interface CloudStatusPayload {
  joinUrl: string;
  trayId?: string;
  updatedAt?: string;
}

async function pollCloudStatus(
  handle: SandboxHandle,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<CloudStatusPayload> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatusPayload;
      if (parsed.joinUrl) return parsed;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  const errSuffix = lastError
    ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
    : ' (file never appeared)';
  throw new Error(
    `cloud-status did not appear within ${opts.timeoutMs}ms; sandbox may have failed to boot${errSuffix}`
  );
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

    let status: CloudStatusPayload;
    try {
      status = await pollCloudStatus(handle, {
        timeoutMs: opts.pollTimeoutMs ?? 60_000,
        intervalMs: opts.pollIntervalMs ?? 500,
      });
    } catch (pollErr) {
      // Surface boot diagnostics before tearing down. Spec failure mode #7.
      const stderr = await tailStderr(handle, 50);
      throw new Error(
        `${pollErr instanceof Error ? pollErr.message : String(pollErr)}\n` +
          `--- last 50 lines of /tmp/slicc-stderr.log ---\n${stderr}`
      );
    }

    const reg = new CloudSessionRegistry(opts.registryPath);
    const nowIso = new Date().toISOString();
    const entry: CloudSessionEntry = {
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
