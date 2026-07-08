/**
 * Canonical list of virtual device files (`/dev/*`) whose write is a genuine
 * no-op. This is the single source of truth shared by two consumers that would
 * otherwise hardcode the same literals and drift:
 *
 *   - `RestrictedFS` (`restricted-fs.ts`) registers the device behavior and
 *     keys `VIRTUAL_DEVICES` off {@link DEV_NULL}.
 *   - The sudoers matcher (`shell/sudo/sudoers.ts`) permits CONTENT writes
 *     (`writeFile`) to these paths so scoops never hit an approval prompt for a
 *     write that discards its payload.
 *
 * Only add a path here when its device `write` truly discards the payload. A
 * device whose write has observable effects MUST NOT be listed — its writes
 * should still be gated by the normal sudoers policy. Adding a qualifying path
 * here auto-wires the SUDOERS MATCHER only (it iterates this shared list).
 * `RestrictedFS` does NOT auto-wire: it keys `VIRTUAL_DEVICES` off the specific
 * device constants and each device needs its own `stat`/`read`/`readText`/`write`
 * implementation there, so a new path also requires a matching `VIRTUAL_DEVICES`
 * entry (with its own no-op `write`) before the write is actually discarded.
 *
 * This module intentionally imports nothing so it can be consumed by the pure,
 * framework-free sudoers matcher without pulling in the filesystem graph (no
 * import cycle).
 */

/** The canonical `/dev/null` path (its write discards all input). */
export const DEV_NULL = '/dev/null';

/** All virtual-device paths whose `write` is a no-op. */
export const NO_OP_WRITE_DEVICE_PATHS = [DEV_NULL] as const;

/** Set form of {@link NO_OP_WRITE_DEVICE_PATHS} for O(1) membership checks. */
export const NO_OP_WRITE_DEVICE_PATH_SET: ReadonlySet<string> = new Set(NO_OP_WRITE_DEVICE_PATHS);

/** Whether `path` (already-normalized) is a no-op-write virtual device. */
export function isNoOpWriteDevicePath(path: string): boolean {
  return NO_OP_WRITE_DEVICE_PATH_SET.has(path);
}
