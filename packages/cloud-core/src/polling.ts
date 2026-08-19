import type { CloudErrorCode } from './errors.js';
import { CloudError } from './errors.js';
import type { SandboxHandle } from './substrate.js';
import type { CloudStatus } from './types.js';

export interface PollOpts {
  timeoutMs: number;
  intervalMs: number;
  /**
   * Reject reads where `updatedAt` is `<=` this ISO timestamp. Required when
   * polling from a fresh sandbox built from a template snapshot — the
   * template-build leaves a stale /tmp/slicc-join.json baked in, so without
   * a freshness floor the first poll returns the build-time tray URL.
   * Caller should pass an ISO timestamp captured at the moment substrate.create()
   * completed. If unset (CLI legacy callers), no freshness check is applied.
   */
  minUpdatedAt?: string;
}

/**
 * Shared poll-until-ready loop behind {@link pollCloudStatus} and
 * {@link pollForRefreshedStatus}. Repeatedly reads `/tmp/slicc-join.json`
 * until it parses to a payload with a `joinUrl` whose `updatedAt` is strictly
 * newer than `floor` (or any well-formed read when `floor` is unset), then
 * returns it. On timeout it throws a {@link CloudError} that distinguishes
 * stale-but-present, last-read-error, and never-appeared cases.
 *
 * The two exports differ only in the freshness floor's source, the error
 * code, and two label strings — captured here as `errorCode`, `floorLabel`,
 * and `timeoutMessage` so the loop itself has a single source of truth.
 */
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
        // Require a STRICTLY newer updatedAt than the freshness floor.
        // If we have no floor (CLI legacy start, or first-time resume of an
        // externally-created sandbox), accept any well-formed read.
        if (!opts.floor) return parsed;
        if (parsed.updatedAt && parsed.updatedAt > opts.floor) return parsed;
        // File exists, joinUrl present, but updatedAt not newer than the
        // floor — capture for the timeout error so we can tell "missing"
        // from "stale".
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
