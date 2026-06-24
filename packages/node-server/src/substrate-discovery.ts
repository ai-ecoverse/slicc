// tva
/**
 * Substrate discovery file (`~/.slicc/substrate.json`).
 *
 * A substrate instance writes this on boot and clears it on shutdown so a
 * *second* orchestrator session can find the running instance's port and
 * attach to it — minting its own `X-Slicc-Session` against the same loopback
 * bridge — instead of accidentally re-running `npm run substrate`, which would
 * boot a parallel instance on the next free port.
 *
 * It is a *hint*, not a lock: a hard crash (SIGKILL) leaves the file behind, so
 * a consumer must still confirm liveness by probing `GET /api/status` on the
 * recorded port and checking `substrate === true`. Every read failure
 * (missing / unreadable / corrupt / wrong-shape / out-of-range) collapses to
 * `null` so the caller falls through to a probe or a fresh launch.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default SLICC runtime-state dir (mirrors `~/.slicc/session-id`, `secrets.env`). */
export function defaultSliccDir(): string {
  return join(homedir(), '.slicc');
}

export interface SubstrateDiscovery {
  /** Served UI / API port the substrate bridge is listening on. */
  port: number;
  /** PID of the node-server process (liveness hint only — confirm via /api/status). */
  pid: number;
  /** ISO-8601 boot timestamp. */
  startedAt: string;
}

export function substrateDiscoveryPath(dir: string = defaultSliccDir()): string {
  return join(dir, 'substrate.json');
}

/**
 * Write the discovery file, overwriting any stale file from a prior (possibly
 * crashed) run. Creates the directory if needed.
 */
export function writeSubstrateDiscovery(
  rec: SubstrateDiscovery,
  dir: string = defaultSliccDir()
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(substrateDiscoveryPath(dir), `${JSON.stringify(rec, null, 2)}\n`, 'utf-8');
}

/**
 * Read + validate the discovery file. Returns `null` on any failure so callers
 * fall through to a `/api/status` probe or a fresh launch.
 */
export function readSubstrateDiscovery(dir: string = defaultSliccDir()): SubstrateDiscovery | null {
  let raw: string;
  try {
    raw = readFileSync(substrateDiscoveryPath(dir), 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { port, pid, startedAt } = parsed as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535)
    return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== 'string' || startedAt.length === 0) return null;
  return { port, pid, startedAt };
}

/** Remove the discovery file on shutdown. Best-effort; never throws. */
export function clearSubstrateDiscovery(dir: string = defaultSliccDir()): void {
  try {
    rmSync(substrateDiscoveryPath(dir), { force: true });
  } catch {
    // best-effort — a leftover file is corrected on the next boot's overwrite.
  }
}
