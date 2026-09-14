import type { CloudErrorCode } from './errors.js';
import { CloudError } from './errors.js';
import type { SandboxHandle } from './substrate.js';
import type { CloudStatus } from './types.js';

export interface PollOpts {
  timeoutMs: number;
  intervalMs: number;

  minUpdatedAt?: string;
}

async function pollJoinFile(
  handle: SandboxHandle,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    floor: string | undefined;
    floorLabel: string;
    errorCode: CloudErrorCode;
    timeoutMessage: (ms: number, errSuffix: string) => string;
  }
): Promise<CloudStatus> {
  const start = Date.now();
  let lastError: unknown = null;
  let lastStalePayload: CloudStatus | null = null;
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatus;
      if (parsed.joinUrl) {
        if (!opts.floor) return parsed;
        if (parsed.updatedAt && parsed.updatedAt > opts.floor) return parsed;

        lastStalePayload = parsed;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  let errSuffix = '';
  if (lastStalePayload) {
    errSuffix =
      ` (file present but stale: ${opts.floorLabel}=${opts.floor}, ` +
      `current.updatedAt=${lastStalePayload.updatedAt}, ` +
      `current.trayId=${lastStalePayload.trayId})`;
  } else if (lastError) {
    errSuffix = ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
  } else {
    errSuffix = ' (file never appeared)';
  }
  throw new CloudError(opts.errorCode, opts.timeoutMessage(opts.timeoutMs, errSuffix));
}

export async function pollCloudStatus(handle: SandboxHandle, opts: PollOpts): Promise<CloudStatus> {
  return pollJoinFile(handle, {
    timeoutMs: opts.timeoutMs,
    intervalMs: opts.intervalMs,
    floor: opts.minUpdatedAt,
    floorLabel: 'minUpdatedAt',
    errorCode: 'SANDBOX_NOT_READY',
    timeoutMessage: (ms, errSuffix) =>
      `cloud-status did not appear within ${ms}ms; sandbox may have failed to boot${errSuffix}`,
  });
}

export async function pollForRefreshedStatus(
  handle: SandboxHandle,
  baselineUpdatedAt: string | undefined,
  opts: PollOpts
): Promise<CloudStatus> {
  return pollJoinFile(handle, {
    timeoutMs: opts.timeoutMs,
    intervalMs: opts.intervalMs,
    floor: baselineUpdatedAt,
    floorLabel: 'baseline.updatedAt',
    errorCode: 'LEADER_NOT_READY',
    timeoutMessage: (ms, errSuffix) => `cloud-status did not refresh within ${ms}ms${errSuffix}`,
  });
}
